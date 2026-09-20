import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createZstdCompress } from "node:zlib";
import type { Request, Response as ExpressResponse } from "express";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const ARTIFACT_MARKER_PREFIX = "CHATGPT_ARTIFACT=";
export const FILE_TRANSFER_MARKER_PREFIX = "CHATGPT_LIBRARY_UPLOAD="; // legacy producer compatibility
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const LOCAL_TRANSFER_TTL_MS = 5 * 60 * 1000;
const LOCAL_RESOURCE_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const ZSTD_MIN_BYTES = 64 * 1024;
const MAX_REVIEW_ZIP_ENTRIES = 512;
const MAX_REVIEW_ZIP_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_MANIFEST_BYTES = 1024 * 1024;
const REVIEW_ZIP_SCHEMAS = new Set(["lowvram.visual-review-transfer.v1", "p3.visual-review-transfer.v1", "tiny3d.visual-review-transfer.v1"]);

const MIME_BY_EXT: Record<string, string> = {
  ".7z": "application/x-7z-compressed",
  ".avi": "video/x-msvideo",
  ".bin": "application/octet-stream",
  ".csv": "text/csv",
  ".fbx": "application/octet-stream",
  ".gif": "image/gif",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".gz": "application/gzip",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".log": "text/plain",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".obj": "model/obj",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".tar": "application/x-tar",
  ".txt": "text/plain",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".zip": "application/zip",
  ".zst": "application/zstd",
};

const ALREADY_COMPRESSED_EXTENSIONS = new Set([
  ".7z", ".avi", ".gif", ".glb", ".gz", ".jpeg", ".jpg", ".mkv", ".mov", ".mp4", ".pdf", ".png", ".webm", ".webp", ".zip", ".zst",
]);


const UploadLocalFileOutputSchema = z.object({
  direction: z.literal("local_to_chatgpt"),
  status: z.literal("ready"),
  delivery_mode: z.literal("tool_file_reference"),
  file_name: z.string(),
  mime_type: z.string(),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  resource_uri: z.string().url(),
});

export type LocalFileTransfer = {
  token: string;
  path: string;
  file_name: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  mtime_ms: number;
  transfer_expires_at: number;
  resource_expires_at: number;
};

type LocalImageResource = {
  token: string;
  source_path: string;
  source_bytes: number;
  source_mtime_ms: number;
  file_name: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  resource_expires_at: number;
  data_offset?: number;
};

type StoredZipEntry = {
  name: string;
  method: number;
  compressed_size: number;
  uncompressed_size: number;
  local_header_offset: number;
};

const localExports = new Map<string, LocalFileTransfer>();
const localImageResources = new Map<string, LocalImageResource>();

function maxFileBytes(): number {
  const configured = Number(process.env.MCP_FILE_TRANSFER_MAX_BYTES || DEFAULT_MAX_FILE_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_FILE_BYTES;
}

function cleanupExpiredResources(now = Date.now()): void {
  for (const [token, item] of localExports) if (item.resource_expires_at <= now) localExports.delete(token);
  for (const [token, item] of localImageResources) if (item.resource_expires_at <= now) localImageResources.delete(token);
}

function mimeTypeFor(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] || "application/octet-stream";
}

export function shouldUseZstd(item: Pick<LocalFileTransfer, "path" | "bytes" | "mime_type">): boolean {
  if (item.bytes < ZSTD_MIN_BYTES) return false;
  const ext = extname(item.path).toLowerCase();
  if (ALREADY_COMPRESSED_EXTENSIONS.has(ext)) return false;
  return item.mime_type.startsWith("text/") || item.mime_type.includes("json") || item.mime_type.includes("gltf") || [".obj", ".fbx", ".bin"].includes(ext);
}

function acceptsZstd(value: string | undefined): boolean {
  if (!value) return false;
  return value.split(",").some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(";");
    if (coding !== "zstd") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function publicOrigin(): URL {
  const raw = (process.env.MCP_PUBLIC_ORIGIN || "").trim();
  if (!raw) throw new Error("MCP_PUBLIC_ORIGIN is required for file transfer");
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("MCP_PUBLIC_ORIGIN must be https for file transfer");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function localTransferUrl(token: string): string {
  const url = new URL("file-transfer/local", publicOrigin());
  url.searchParams.set("token", token);
  return url.href;
}

export async function prepareLocalFileTransfer(path: string): Promise<LocalFileTransfer> {
  cleanupExpiredResources();
  if (!isAbsolute(path)) throw new Error("artifact path must be absolute");
  const info = await stat(path);
  const maxBytes = maxFileBytes();
  if (!info.isFile() || info.size <= 0 || info.size > maxBytes) throw new Error(`artifact must name a 1..${maxBytes} byte file`);
  const item: LocalFileTransfer = {
    token: randomUUID(),
    path,
    file_name: basename(path),
    mime_type: mimeTypeFor(path),
    bytes: info.size,
    sha256: await sha256File(path),
    mtime_ms: info.mtimeMs,
    transfer_expires_at: Date.now() + LOCAL_TRANSFER_TTL_MS,
    resource_expires_at: Date.now() + LOCAL_RESOURCE_TTL_MS,
  };
  localExports.set(item.token, item);
  if (item.mime_type.startsWith("image/")) {
    localImageResources.set(item.token, {
      token: item.token, source_path: item.path, source_bytes: item.bytes, source_mtime_ms: item.mtime_ms,
      file_name: item.file_name, mime_type: item.mime_type, bytes: item.bytes, sha256: item.sha256, resource_expires_at: item.resource_expires_at,
    });
  }
  return item;
}

function markedArtifactPaths(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const stdout = (value as Record<string, unknown>).stdout;
  if (typeof stdout !== "string") return [];
  const prefixes = [ARTIFACT_MARKER_PREFIX, FILE_TRANSFER_MARKER_PREFIX] as const;
  const paths: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const prefix = prefixes.find((candidate) => line.startsWith(candidate));
    if (!prefix) continue;
    const path = line.slice(prefix.length).trim();
    if (path) paths.push(path);
  }
  const trimmed = stdout.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const declared = parsed.chatgpt_artifacts;
      if (Array.isArray(declared)) {
        for (const candidate of declared) if (typeof candidate === "string" && candidate.trim()) paths.push(candidate.trim());
      }
    } catch { /* stdout is not a single JSON result; line markers remain authoritative */ }
  }
  return paths;
}

type ArtifactDeliveryState = { marker_count: number; dropped_from_start: number; touched_at: number };
const artifactDeliveryState = new Map<string, ArtifactDeliveryState>();

function newlyMarkedArtifactPaths(value: unknown): string[] {
  const paths = markedArtifactPaths(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return paths;
  const record = value as Record<string, unknown>;
  const processId = typeof record.process_id === "string" ? record.process_id : "";
  if (!processId) return paths;
  const dropped = typeof record.stdout_dropped_from_start === "number" ? record.stdout_dropped_from_start : 0;
  const prior = artifactDeliveryState.get(processId);
  const reset = !prior || prior.dropped_from_start !== dropped || paths.length < prior.marker_count;
  const start = reset ? 0 : prior.marker_count;
  artifactDeliveryState.set(processId, { marker_count: paths.length, dropped_from_start: dropped, touched_at: Date.now() });
  if (artifactDeliveryState.size > 512) {
    const oldest = [...artifactDeliveryState.entries()].sort((a, b) => a[1].touched_at - b[1].touched_at).slice(0, artifactDeliveryState.size - 512);
    for (const [key] of oldest) artifactDeliveryState.delete(key);
  }
  return paths.slice(start);
}

export async function prepareMarkedLocalFileTransfers(value: unknown): Promise<LocalFileTransfer[]> {
  return Promise.all(markedArtifactPaths(value).map((path) => prepareLocalFileTransfer(path)));
}

export async function prepareMarkedLocalFileTransfer(value: unknown): Promise<LocalFileTransfer | null> {
  const transfers = await prepareMarkedLocalFileTransfers(value);
  return transfers.at(-1) || null;
}


type ImageResolution = { width: number; height: number };

function readUInt24LE(data: Buffer, offset: number): number {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
}

function imageResolution(data: Buffer, mimeType: string): ImageResolution {
  if (mimeType === "image/png") {
    if (data.length < 24 || data.toString("ascii", 1, 4) !== "PNG") throw new Error("invalid PNG image");
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (mimeType === "image/gif") {
    if (data.length < 10 || !/^GIF8[79]a$/.test(data.toString("ascii", 0, 6))) throw new Error("invalid GIF image");
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if (mimeType === "image/jpeg") {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new Error("invalid JPEG image");
    const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset] !== 0xff) { offset += 1; continue; }
      while (offset < data.length && data[offset] === 0xff) offset += 1;
      if (offset >= data.length) break;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) break;
      const segmentLength = data.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > data.length) break;
      if (sof.has(marker) && segmentLength >= 7) {
        return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
      }
      offset += segmentLength;
    }
    throw new Error("JPEG dimensions not found");
  }
  if (mimeType === "image/webp") {
    if (data.length < 30 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP") throw new Error("invalid WebP image");
    const chunk = data.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: readUInt24LE(data, 24) + 1, height: readUInt24LE(data, 27) + 1 };
    if (chunk === "VP8L") {
      if (data[20] !== 0x2f) throw new Error("invalid lossless WebP image");
      const b1 = data[21], b2 = data[22], b3 = data[23], b4 = data[24];
      return { width: 1 + ((b1 | (b2 << 8)) & 0x3fff), height: 1 + (((b2 >> 6) | (b3 << 2) | (b4 << 10)) & 0x3fff) };
    }
    if (chunk === "VP8 ") {
      if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) throw new Error("invalid lossy WebP image");
      return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    }
    throw new Error("unsupported WebP image layout");
  }
  throw new Error(`unsupported inline image type: ${mimeType}`);
}

function inlineImageContent(data: Buffer, mimeType: string): any[] {
  const { width, height } = imageResolution(data, mimeType);
  return [
    // Keep a tiny text block first for ChatGPT hosts that classify mixed tool results
    // from the leading content item. This reuses the existing resolution metadata and
    // does not restore the duplicate process JSON removed by #366.
    { type: "text" as const, text: `resolution: ${width}x${height}` },
    { type: "image" as const, data: data.toString("base64"), mimeType },
  ];
}

async function directImageHandoff(path: string, mimeType: string): Promise<{ content: any[] }> {
  if (!isAbsolute(path)) throw new Error("artifact path must be absolute");
  const info = await stat(path);
  const maxBytes = maxFileBytes();
  if (!info.isFile() || info.size <= 0 || info.size > maxBytes) throw new Error(`artifact must name a 1..${maxBytes} byte file`);
  const data = await readFile(path);
  return { content: inlineImageContent(data, mimeType) };
}

export function localTransferSummary(item: LocalFileTransfer) {
  return {
    direction: "local_to_chatgpt" as const,
    status: "ready" as const,
    delivery_mode: "tool_file_reference" as const,
    file_name: item.file_name,
    mime_type: item.mime_type,
    bytes: item.bytes,
    sha256: item.sha256,
    resource_uri: `mcp-upload://file-transfer/${item.token}`,
  };
}

export function localFileResourceLink(item: LocalFileTransfer) {
  return {
    type: "resource_link" as const,
    uri: `mcp-upload://file-transfer/${item.token}`,
    name: item.file_name,
    title: item.file_name,
    description: "Exact original local file returned as a first-class tool-result file reference",
    mimeType: item.mime_type,
    size: item.bytes,
    annotations: { audience: ["assistant", "user"] as ("assistant" | "user")[] },
  };
}

function localImageResourceUri(item: LocalImageResource): string {
  return `mcp-upload://file-transfer/${item.token}`;
}

export function localImageResourceLink(item: LocalImageResource) {
  return {
    type: "resource_link" as const,
    uri: localImageResourceUri(item),
    name: item.file_name,
    title: item.file_name,
    description: "Exact original local image for immediate model vision and inline preview",
    mimeType: item.mime_type,
    size: item.bytes,
    annotations: { audience: ["assistant", "user"] as ("assistant" | "user")[] },
  };
}

async function readExactly(handle: Awaited<ReturnType<typeof open>>, length: number, position: number): Promise<Buffer> {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(position) || position < 0) throw new Error("invalid file range");
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead <= 0) throw new Error("unexpected end of file");
    offset += bytesRead;
  }
  return buffer;
}

function safeArchivePath(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

async function storedZipDirectory(path: string, sourceBytes: number): Promise<Map<string, StoredZipEntry>> {
  const handle = await open(path, "r");
  try {
    const tailBytes = Math.min(sourceBytes, 22 + 0xffff);
    const tail = await readExactly(handle, tailBytes, sourceBytes - tailBytes);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) !== 0x06054b50) continue;
      const commentLength = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLength === tail.length) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("ZIP end-of-central-directory missing");
    const disk = tail.readUInt16LE(eocd + 4);
    const centralDisk = tail.readUInt16LE(eocd + 6);
    const entriesOnDisk = tail.readUInt16LE(eocd + 8);
    const entryCount = tail.readUInt16LE(eocd + 10);
    const centralBytes = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw new Error("multi-disk ZIP is unsupported");
    if (entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 central directory is unsupported for review packages");
    if (entryCount < 1 || entryCount > MAX_REVIEW_ZIP_ENTRIES) throw new Error(`review ZIP entry count must be 1..${MAX_REVIEW_ZIP_ENTRIES}`);
    if (centralBytes <= 0 || centralBytes > MAX_REVIEW_ZIP_DIRECTORY_BYTES || centralOffset + centralBytes > sourceBytes) throw new Error("review ZIP central directory is out of bounds");
    const central = await readExactly(handle, centralBytes, centralOffset);
    const entries = new Map<string, StoredZipEntry>();
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) throw new Error("invalid ZIP central directory record");
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const diskStart = central.readUInt16LE(cursor + 34);
      const localHeaderOffset = central.readUInt32LE(cursor + 42);
      const recordBytes = 46 + nameLength + extraLength + commentLength;
      if (cursor + recordBytes > central.length) throw new Error("truncated ZIP central directory record");
      if ((flags & 1) !== 0) throw new Error("encrypted review ZIP entries are unsupported");
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff || diskStart === 0xffff) throw new Error("ZIP64 central entries are unsupported for review packages");
      if (diskStart !== 0) throw new Error("multi-disk ZIP entry is unsupported");
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      if (!safeArchivePath(name) || entries.has(name)) throw new Error(`unsafe or duplicate ZIP entry: ${name}`);
      entries.set(name, { name, method, compressed_size: compressedSize, uncompressed_size: uncompressedSize, local_header_offset: localHeaderOffset });
      cursor += recordBytes;
    }
    if (cursor !== central.length) throw new Error("unexpected bytes in ZIP central directory");
    return entries;
  } finally {
    await handle.close();
  }
}

async function storedZipDataOffset(path: string, sourceBytes: number, entry: StoredZipEntry): Promise<number> {
  const handle = await open(path, "r");
  try {
    if (entry.local_header_offset + 30 > sourceBytes) throw new Error(`ZIP local header out of bounds: ${entry.name}`);
    const header = await readExactly(handle, 30, entry.local_header_offset);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`invalid ZIP local header: ${entry.name}`);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const dataOffset = entry.local_header_offset + 30 + nameLength + extraLength;
    if (dataOffset + entry.compressed_size > sourceBytes) throw new Error(`ZIP member out of bounds: ${entry.name}`);
    return dataOffset;
  } finally {
    await handle.close();
  }
}

async function readStoredZipMember(path: string, sourceBytes: number, entry: StoredZipEntry): Promise<Buffer> {
  if (entry.method !== 0 || entry.compressed_size !== entry.uncompressed_size) throw new Error(`review ZIP member is not STORE/no-compression: ${entry.name}`);
  const dataOffset = await storedZipDataOffset(path, sourceBytes, entry);
  const handle = await open(path, "r");
  try { return await readExactly(handle, entry.uncompressed_size, dataOffset); }
  finally { await handle.close(); }
}

function visualReviewManifestFiles(manifest: any): any[] {
  const schema = String(manifest?.schema || "");
  if (schema !== "tiny3d.visual-review-transfer.v1") {
    if (!Array.isArray(manifest?.files)) throw new Error("visual review ZIP manifest has invalid files array");
    return manifest.files;
  }

  const assets = Array.isArray(manifest?.assets) ? manifest.assets : [];
  if (!Number.isSafeInteger(manifest?.asset_count) || manifest.asset_count !== assets.length || assets.length < 1) {
    throw new Error("Tiny3D visual review ZIP asset count mismatch");
  }
  const files: any[] = [];
  let mediaCount = 0;
  const seenAssets = new Set<string>();
  for (const asset of assets) {
    const assetId = String(asset?.asset_id || "");
    if (!/^[0-9a-f]{64}$/.test(assetId) || seenAssets.has(assetId)) throw new Error(`Tiny3D visual review ZIP has invalid/duplicate asset_id: ${assetId}`);
    seenAssets.add(assetId);
    if (asset?.view_set !== "twelve_standard_v1") throw new Error(`Tiny3D visual review ZIP has unsupported view_set for ${assetId}`);
    const views = Array.isArray(asset?.views) ? asset.views : [];
    if (views.length !== 12) throw new Error(`Tiny3D visual review ZIP requires 12 views for ${assetId}`);
    const receipt = asset?.receipt;
    if (!receipt || typeof receipt !== "object") throw new Error(`Tiny3D visual review ZIP receipt missing for ${assetId}`);
    files.push({ ...receipt, role: `receipt:${assetId}`, source_name: `${assetId}_library_preview.json` });
    for (const view of views) {
      const label = String(view?.label || "");
      if (!label) throw new Error(`Tiny3D visual review ZIP view label missing for ${assetId}`);
      files.push({ ...view, role: `view:${assetId}:${label}`, source_name: `${assetId}_${label}.png` });
      mediaCount += 1;
    }
  }
  if (!Number.isSafeInteger(manifest?.media_count) || manifest.media_count !== mediaCount) throw new Error("Tiny3D visual review ZIP media count mismatch");
  return files;
}

async function visualReviewZipResources(item: LocalFileTransfer): Promise<LocalImageResource[]> {
  if (item.mime_type !== "application/zip") return [];
  let entries: Map<string, StoredZipEntry>;
  try { entries = await storedZipDirectory(item.path, item.bytes); }
  catch { return []; }
  const manifestEntry = entries.get("manifest.json");
  if (!manifestEntry || manifestEntry.method !== 0 || manifestEntry.uncompressed_size <= 0 || manifestEntry.uncompressed_size > MAX_REVIEW_MANIFEST_BYTES) return [];
  let manifest: any;
  try { manifest = JSON.parse((await readStoredZipMember(item.path, item.bytes, manifestEntry)).toString("utf8")); }
  catch { return []; }
  if (!REVIEW_ZIP_SCHEMAS.has(String(manifest?.schema || ""))) return [];
  const manifestFiles = visualReviewManifestFiles(manifest);
  if (manifestFiles.length < 1 || manifestFiles.length > MAX_REVIEW_ZIP_ENTRIES - 1) throw new Error("visual review ZIP manifest has invalid files array");

  const declared = new Set<string>();
  const resources: LocalImageResource[] = [];
  for (const raw of manifestFiles) {
    const archivePath = String(raw?.archive_path || "");
    const bytes = Number(raw?.bytes);
    const sha256 = String(raw?.sha256 || "").toLowerCase();
    if (!safeArchivePath(archivePath) || declared.has(archivePath)) throw new Error(`visual review ZIP manifest has unsafe or duplicate path: ${archivePath}`);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`visual review ZIP manifest has invalid integrity metadata: ${archivePath}`);
    declared.add(archivePath);
    const entry = entries.get(archivePath);
    if (!entry) throw new Error(`visual review ZIP declared member missing: ${archivePath}`);
    if (entry.method !== 0 || entry.compressed_size !== entry.uncompressed_size) throw new Error(`visual review ZIP member is not STORE/no-compression: ${archivePath}`);
    if (entry.uncompressed_size !== bytes) throw new Error(`visual review ZIP byte count mismatch: ${archivePath}`);
    const mimeType = mimeTypeFor(archivePath);
    if (!mimeType.startsWith("image/")) continue;
    const token = randomUUID();
    const resource: LocalImageResource = {
      token,
      source_path: item.path,
      source_bytes: item.bytes,
      source_mtime_ms: item.mtime_ms,
      file_name: String(raw?.source_name || basename(archivePath)),
      mime_type: mimeType,
      bytes,
      sha256,
      resource_expires_at: item.resource_expires_at,
      data_offset: await storedZipDataOffset(item.path, item.bytes, entry),
    };
    localImageResources.set(token, resource);
    resources.push(resource);
  }
  if (entries.size !== declared.size + 1 || [...entries.keys()].some((name) => name !== "manifest.json" && !declared.has(name))) throw new Error("visual review ZIP contains undeclared members");
  return resources;
}

async function localImageResourceBytes(image: LocalImageResource): Promise<Buffer> {
  const current = await stat(image.source_path).catch(() => null);
  if (!current?.isFile() || current.size !== image.source_bytes || current.mtimeMs !== image.source_mtime_ms) {
    localImageResources.delete(image.token);
    throw new Error("source file container changed after transfer preparation");
  }
  let data: Buffer;
  if (image.data_offset === undefined) {
    data = await readFile(image.source_path);
  } else {
    const handle = await open(image.source_path, "r");
    try { data = await readExactly(handle, image.bytes, image.data_offset); }
    finally { await handle.close(); }
  }
  if (data.length !== image.bytes) throw new Error("source file size changed while reading");
  if (image.sha256) {
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== image.sha256) throw new Error("source file hash changed while reading");
  }
  return data;
}

async function localFileResourceContents(uri: string) {
  cleanupExpiredResources();
  const parsed = new URL(uri);
  if (parsed.protocol !== "mcp-upload:" || parsed.hostname !== "file-transfer") throw new Error("unsupported file-transfer resource URI");
  const token = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const image = localImageResources.get(token);
  if (image) {
    const data = await localImageResourceBytes(image);
    return { uri, mimeType: image.mime_type, blob: data.toString("base64") };
  }
  const item = localExports.get(token);
  if (!item) throw new Error("file-transfer resource is unavailable or expired");
  const current = await stat(item.path).catch(() => null);
  if (!current?.isFile() || current.size !== item.bytes || current.mtimeMs !== item.mtime_ms) {
    localExports.delete(token);
    throw new Error("source file changed after transfer preparation");
  }
  const data = await readFile(item.path);
  if (data.length !== item.bytes) throw new Error("source file size changed while reading");
  const digest = createHash("sha256").update(data).digest("hex");
  if (digest !== item.sha256) throw new Error("source file hash changed while reading");
  return { uri, mimeType: item.mime_type, blob: data.toString("base64") };
}

function zstdStream() {
  return createZstdCompress({ params: { [zlibConstants.ZSTD_c_compressionLevel]: 1 } });
}

export async function serveLocalFileTransfer(req: Request, res: ExpressResponse): Promise<void> {
  cleanupExpiredResources();
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const item = token ? localExports.get(token) : undefined;
  if (!item || item.transfer_expires_at <= Date.now()) {
    res.status(404).send("File transfer token is invalid or expired");
    return;
  }
  const current = await stat(item.path).catch(() => null);
  if (!current?.isFile() || current.size !== item.bytes || current.mtimeMs !== item.mtime_ms) {
    localExports.delete(token);
    res.status(409).send("Source file changed after transfer preparation");
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", item.mime_type);
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(item.file_name)}`);
  res.setHeader("X-File-Bytes", String(item.bytes));
  res.setHeader("X-File-Sha256", item.sha256);
  res.setHeader("ETag", `"sha256-${item.sha256}"`);
  res.setHeader("Vary", "Accept-Encoding");

  const compress = acceptsZstd(req.header("accept-encoding")) && shouldUseZstd(item);
  if (compress) {
    res.setHeader("Content-Encoding", "zstd");
    res.setHeader("X-File-Transfer-Encoding", "zstd-1");
    await pipeline(createReadStream(item.path), zstdStream(), res);
  } else {
    res.setHeader("Content-Length", String(item.bytes));
    res.setHeader("X-File-Transfer-Encoding", "identity");
    await pipeline(createReadStream(item.path), res);
  }
  // The browser-facing transfer capability stays short-lived. The authenticated MCP
  // resource has a separate longer lifetime so Chat/Work can revisit the exact bytes
  // without re-uploading or materializing the image for each inspection.
}

export async function localFileTransferHandoff(item: LocalFileTransfer) {
  const reviewImages = item.mime_type === "application/zip" ? await visualReviewZipResources(item) : [];
  const content: any[] = [localFileResourceLink(item)];
  for (const image of reviewImages) {
    content.push(...inlineImageContent(await localImageResourceBytes(image), image.mime_type));
  }
  return { item, content, summary: localTransferSummary(item) };
}

export async function prepareMarkedArtifactHandoffs(value: unknown): Promise<Array<{ content: any[] }>> {
  const handoffs: Array<{ content: any[] }> = [];
  for (const path of newlyMarkedArtifactPaths(value)) {
    const mimeType = mimeTypeFor(path);
    if (mimeType.startsWith("image/")) {
      handoffs.push(await directImageHandoff(path, mimeType));
      continue;
    }
    handoffs.push(await localFileTransferHandoff(await prepareLocalFileTransfer(path)));
  }
  return handoffs;
}

export function registerArtifactFileResource(server: McpServer, callerId: string): void {
  server.registerResource(
    "file-transfer-resource",
    new ResourceTemplate("mcp-upload://file-transfer/{token}", { list: undefined }),
    { title: "Exact transferred file", description: "Exact original local file or manifest-declared review member returned by a tool" },
    async (uri) => ({ contents: [await localFileResourceContents(uri.href)] }),
  );

}
