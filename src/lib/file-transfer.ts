import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { basename, dirname, extname, isAbsolute } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createZstdCompress } from "node:zlib";
import type { Request, Response as ExpressResponse } from "express";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { acknowledgeVisualProofSpoolBatch, readVisualProofSpoolBatch, type PendingVisualProof } from "./visual-proof-spool.js";

export const FILE_TRANSFER_WIDGET_URI = "ui://process/file-transfer-v7.html";
export const FILE_TRANSFER_MARKER_PREFIX = "CHATGPT_LIBRARY_UPLOAD=";
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const LEGACY_FILE_TRANSFER_WIDGET_URIS = ["ui://process/file-transfer-v1.html", "ui://process/file-transfer-v4.html", "ui://process/file-transfer-v5.html"] as const;
const LOCAL_TRANSFER_TTL_MS = 5 * 60 * 1000;
const LOCAL_RESOURCE_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const ZSTD_MIN_BYTES = 64 * 1024;
const MAX_REDIRECTS = 4;
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

const ChatgptFileSchema = z.object({
  download_url: z.string().min(1),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

export type ChatgptFileInput = z.infer<typeof ChatgptFileSchema>;

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

const DownloadChatgptFileOutputSchema = z.object({
  direction: z.literal("chatgpt_to_local"),
  status: z.literal("ok"),
  file_id: z.string(),
  file_name: z.string(),
  mime_type: z.string(),
  destination_path: z.string(),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
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
  if (!isAbsolute(path)) throw new Error("upload_local_file path must be absolute");
  const info = await stat(path);
  const maxBytes = maxFileBytes();
  if (!info.isFile() || info.size <= 0 || info.size > maxBytes) throw new Error(`upload_local_file must name a 1..${maxBytes} byte file`);
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

export async function prepareMarkedLocalFileTransfers(value: unknown): Promise<LocalFileTransfer[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const stdout = (value as Record<string, unknown>).stdout;
  if (typeof stdout !== "string") return [];
  const paths = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(FILE_TRANSFER_MARKER_PREFIX))
    .map((line) => line.slice(FILE_TRANSFER_MARKER_PREFIX.length).trim())
    .filter((path) => path.length > 0);
  const uniquePaths = [...new Set(paths)];
  return Promise.all(uniquePaths.map((path) => prepareLocalFileTransfer(path)));
}

export async function prepareMarkedLocalFileTransfer(value: unknown): Promise<LocalFileTransfer | null> {
  const transfers = await prepareMarkedLocalFileTransfers(value);
  return transfers.at(-1) || null;
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

function localTransferMeta(item: LocalFileTransfer) {
  return {
    direction: "local_to_chatgpt" as const,
    phase: "ready" as const,
    transfer_url: localTransferUrl(item.token),
    resource_uri: `mcp-upload://file-transfer/${item.token}`,
    file_name: item.file_name,
    mime_type: item.mime_type,
    bytes: item.bytes,
    sha256: item.sha256,
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

async function localFileResourceContents(uri: string) {
  cleanupExpiredResources();
  const parsed = new URL(uri);
  if (parsed.protocol !== "mcp-upload:" || parsed.hostname !== "file-transfer") throw new Error("unsupported file-transfer resource URI");
  const token = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const image = localImageResources.get(token);
  if (image) {
    const current = await stat(image.source_path).catch(() => null);
    if (!current?.isFile() || current.size !== image.source_bytes || current.mtimeMs !== image.source_mtime_ms) {
      localImageResources.delete(token);
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
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== image.sha256) throw new Error("source file hash changed while reading");
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

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function isPrivateIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version !== 6) return true;
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("fc") || normalized.startsWith("fd");
}

export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("download URL must be public https");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateIp(host)) throw new Error("download URL must not target a private address");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) throw new Error("download URL resolved to a non-public address");
  return url;
}

type FetchLike = (input: string | URL | globalThis.Request, init?: globalThis.RequestInit) => Promise<globalThis.Response>;

async function fetchExactFile(
  rawUrl: string,
  fetchImpl: FetchLike,
  validateUrl: (raw: string) => Promise<URL>,
): Promise<globalThis.Response> {
  let url = await validateUrl(rawUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchImpl(url, { redirect: "manual", headers: { "accept-encoding": "identity" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === MAX_REDIRECTS) throw new Error("ChatGPT file download redirect limit exceeded");
      url = await validateUrl(new URL(location, url).href);
      continue;
    }
    return response;
  }
  throw new Error("ChatGPT file download redirect limit exceeded");
}

export async function downloadChatgptFile(
  file: ChatgptFileInput,
  destinationPath: string,
  overwrite = false,
  options: { fetchImpl?: FetchLike; validateUrl?: (raw: string) => Promise<URL> } = {},
) {
  if (!isAbsolute(destinationPath)) throw new Error("download_chatgpt_file destination_path must be absolute");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const validateUrl = options.validateUrl || assertPublicHttpsUrl;
  const response = await fetchExactFile(file.download_url, fetchImpl, validateUrl);
  if (!response.ok || !response.body) throw new Error(`ChatGPT file download failed with HTTP ${response.status}`);
  const contentEncoding = (response.headers.get("content-encoding") || "identity").toLowerCase();
  if (contentEncoding !== "identity") throw new Error(`ChatGPT file download returned unexpected content-encoding ${contentEncoding}`);
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxFileBytes()) throw new Error(`downloaded file exceeds ${maxFileBytes()} byte limit`);

  await mkdir(dirname(destinationPath), { recursive: true });
  const existing = await stat(destinationPath).catch(() => null);
  if (existing && !overwrite) throw new Error("destination already exists; set overwrite=true to replace it");

  const tempPath = `${destinationPath}.part-${randomUUID()}`;
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > maxFileBytes()) {
        callback(new Error(`downloaded file exceeds ${maxFileBytes()} byte limit`));
        return;
      }
      hash.update(data);
      callback(null, data);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(tempPath, { flags: "wx" }));
    if (bytes <= 0) throw new Error("downloaded file was empty");
    if (existing && overwrite) await rm(destinationPath, { force: true });
    await rename(tempPath, destinationPath);
    return {
      status: "ok",
      file_id: file.file_id,
      file_name: file.file_name || basename(destinationPath),
      mime_type: file.mime_type || mimeTypeFor(destinationPath),
      destination_path: destinationPath,
      bytes,
      sha256: hash.digest("hex"),
    };
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

const LIBRARY_SPOOL_BRIDGE_TTL_MS = 8 * 60 * 60 * 1000;
type LibrarySpoolBridgeSession = {
  expires_at: number;
  in_flight?: { id: string; pending: PendingVisualProof; item: LocalFileTransfer };
};
const librarySpoolBridgeSessions = new Map<string, LibrarySpoolBridgeSession>();

function cleanupLibrarySpoolBridgeSessions(now = Date.now()): void {
  for (const [token, session] of librarySpoolBridgeSessions) if (session.expires_at <= now) librarySpoolBridgeSessions.delete(token);
}

function librarySpoolBridgeUrl(kind: "next" | "ack", token: string): string {
  const url = new URL(`visual-proof/library-bridge/${kind}`, publicOrigin());
  url.searchParams.set("token", token);
  return url.href;
}

export function createLibrarySpoolBridgeSession() {
  cleanupLibrarySpoolBridgeSessions();
  const token = randomUUID();
  const expires_at = Date.now() + LIBRARY_SPOOL_BRIDGE_TTL_MS;
  librarySpoolBridgeSessions.set(token, { expires_at });
  return {
    next_url: librarySpoolBridgeUrl("next", token),
    ack_url: librarySpoolBridgeUrl("ack", token),
    expires_at,
    poll_ms: 250,
  };
}

function bridgeSession(req: Request): LibrarySpoolBridgeSession | undefined {
  cleanupLibrarySpoolBridgeSessions();
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const session = token ? librarySpoolBridgeSessions.get(token) : undefined;
  if (session) session.expires_at = Date.now() + LIBRARY_SPOOL_BRIDGE_TTL_MS;
  return session;
}

export async function serveLibrarySpoolBridgeNext(req: Request, res: ExpressResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  const session = bridgeSession(req);
  if (!session) { res.status(404).send("Library spool bridge token is invalid or expired"); return; }
  if (!session.in_flight) {
    const batch = await readVisualProofSpoolBatch(512);
    const pending = batch.pending[0];
    if (!pending) { res.status(204).end(); return; }
    const item = await prepareLocalFileTransfer(pending.filePath);
    session.in_flight = { id: basename(pending.manifestPath), pending, item };
  }
  const current = session.in_flight;
  res.json({ status: "ready", id: current.id, file_transfer: localTransferMeta(current.item) });
}

export async function serveLibrarySpoolBridgeAck(req: Request, res: ExpressResponse): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  const session = bridgeSession(req);
  if (!session) { res.status(404).send("Library spool bridge token is invalid or expired"); return; }
  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!session.in_flight || !id || id !== session.in_flight.id) { res.status(409).send("Library spool bridge acknowledgement does not match current proof"); return; }
  await acknowledgeVisualProofSpoolBatch([session.in_flight.pending]);
  session.in_flight = undefined;
  res.json({ status: "ok", id });
}

function widgetResourceMeta() {
  let origin = "";
  try { origin = publicOrigin().origin; } catch { origin = ""; }
  const connectDomains = origin ? [origin] : [];
  return {
    ui: { prefersBorder: false, csp: { connectDomains, resourceDomains: connectDomains } },
    "openai/widgetDescription": "Inert compatibility surface for native exact-byte file resources.",
    "openai/widgetPrefersBorder": false,
    "openai/widgetCSP": { connect_domains: connectDomains, resource_domains: connectDomains },
  };
}

const LOCAL_FILE_TOOL_NAMES = ["upload_local_file", "read_local_file"] as const;
type LocalFileToolName = typeof LOCAL_FILE_TOOL_NAMES[number];

function localFileToolName(): LocalFileToolName {
  const raw = (process.env.MCP_LOCAL_FILE_TOOL_NAME || "upload_local_file").trim();
  if ((LOCAL_FILE_TOOL_NAMES as readonly string[]).includes(raw)) return raw as LocalFileToolName;
  throw new Error(`MCP_LOCAL_FILE_TOOL_NAME must be one of ${LOCAL_FILE_TOOL_NAMES.join(",")}`);
}

function localFileToolPresentation(name: LocalFileToolName) {
  if (name === "read_local_file") {
    return {
      title: "Read local file",
      description: "Read one exact local file and return its unchanged bytes as a native MCP file resource for ChatGPT. This read-only tool does not modify local state, mount an app/widget, or invoke the Library upload API. Transfers preserve exact bytes and SHA-256; images remain compact lazy resources and ZIP review members remain exact resource links.",
      invoking: "Reading file…",
    };
  }
  return {
    title: "Share local file",
    description: "Return one exact local file as a native MCP file resource for ChatGPT to materialize as a native conversation file. This tool never mounts an app/widget or invokes the Library upload API. Transfers preserve exact bytes and SHA-256; images remain compact lazy resources and ZIP review members remain exact resource links.",
    invoking: "Preparing file…",
  };
}

export function librarySpoolBridgeEnabled(): boolean { return process.env.MCP_LIBRARY_SPOOL_BRIDGE === '1' || (process.env.MCP_RUNTIME_INSTANCE_ID || '').startsWith('issue333-persistent-widget-'); }

function uploadToolMeta(name: LocalFileToolName) {
  const presentation = localFileToolPresentation(name);
  if (name === "read_local_file" || !librarySpoolBridgeEnabled()) {
    return {
      "openai/toolInvocation/invoking": presentation.invoking,
      "openai/toolInvocation/invoked": "File ready",
    };
  }
  return {
    ui: { resourceUri: FILE_TRANSFER_WIDGET_URI, visibility: ["model", "app"] },
    "openai/outputTemplate": FILE_TRANSFER_WIDGET_URI,
    "openai/toolInvocation/invoking": presentation.invoking,
    "openai/toolInvocation/invoked": "File ready",
  };
}

export async function localFileTransferHandoff(item: LocalFileTransfer) {
  const directImage = item.mime_type.startsWith("image/") ? localImageResources.get(item.token) : undefined;
  const reviewImages = directImage ? [] : await visualReviewZipResources(item);
  const content: any[] = [localFileResourceLink(item)];
  // Keep large image bytes out of CallToolResult. ResourceLink is the MCP-native
  // lazy-fetch boundary: Chat/Work can fetch the exact resource on demand without
  // inflating the conversation transcript with base64 image payloads.
  // Preserve the MCP-readable exact image resource used by native vision and the
  // manifest-declared review resources. The first resource_link above is always the
  // original file itself and remains useful in Work/other hosts that do not mount UI.
  content.push(...reviewImages.map(localImageResourceLink));
  return { item, content, summary: localTransferSummary(item) };
}

export function registerFileTransferTools(server: McpServer, callerId: string): void {
  server.registerResource(
    "file-transfer-resource",
    new ResourceTemplate("mcp-upload://file-transfer/{token}", { list: undefined }),
    { title: "Exact transferred file", description: "Exact original local file or manifest-declared review member returned by a tool" },
    async (uri) => ({ contents: [await localFileResourceContents(uri.href)] }),
  );
  server.registerResource("process-file-transfer-widget", FILE_TRANSFER_WIDGET_URI, { mimeType: MCP_APP_MIME_TYPE }, async () => ({
    contents: [{
      uri: FILE_TRANSFER_WIDGET_URI,
      mimeType: MCP_APP_MIME_TYPE,
      text: fileTransferWidgetHtml(),
      _meta: widgetResourceMeta(),
    }],
  }));
  for (const [index, uri] of LEGACY_FILE_TRANSFER_WIDGET_URIS.entries()) {
    server.registerResource(`process-file-transfer-widget-legacy-${index + 1}`, uri, { mimeType: MCP_APP_MIME_TYPE }, async () => ({
      contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text: fileTransferWidgetHtml(), _meta: widgetResourceMeta() }],
    }));
  }

  const localFileName = localFileToolName();
  const localFilePresentation = localFileToolPresentation(localFileName);
  server.registerTool(
    localFileName,
    {
      title: localFilePresentation.title,
      description: localFilePresentation.description,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: uploadToolMeta(localFileName),
      inputSchema: z.object({ path: z.string().min(1) }),
      outputSchema: UploadLocalFileOutputSchema,
    },
    async ({ path }) => {
      const handoff = await localFileTransferHandoff(await prepareLocalFileTransfer(path));
      const bridge = localFileName === "upload_local_file" && librarySpoolBridgeEnabled() ? createLibrarySpoolBridgeSession() : undefined;
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ caller_id: callerId, ...handoff.summary }) },
          ...handoff.content,
        ],
        structuredContent: handoff.summary,
        ...(bridge ? { _meta: { file_transfer: localTransferMeta(handoff.item), library_spool_bridge: bridge } } : {}),
      };
    },
  );

  server.registerTool(
    "download_chatgpt_file",
    {
      title: "Save ChatGPT file",
      description: "Save one exact ChatGPT file onto the MCP host without transcoding. Pass the ChatGPT file in file and an absolute destination_path; overwrite defaults to false. The server streams the temporary ChatGPT download URL directly to disk and returns byte count plus SHA-256.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: {
        "openai/fileParams": ["file"],
        "openai/toolInvocation/invoking": "Saving file…",
        "openai/toolInvocation/invoked": "File saved",
      },
      inputSchema: z.object({
        file: ChatgptFileSchema,
        destination_path: z.string().min(1),
        overwrite: z.boolean().optional(),
      }),
      outputSchema: DownloadChatgptFileOutputSchema,
    },
    async ({ file, destination_path, overwrite = false }) => {
      const result = await downloadChatgptFile(file, destination_path, overwrite);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ caller_id: callerId, ...result }) }],
        structuredContent: { direction: "chatgpt_to_local", ...result },
      };
    },
  );
}

export function fileTransferWidgetHtml(): string {
  if (!librarySpoolBridgeEnabled()) return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color-scheme:light dark}html,body{margin:0;padding:0;background:transparent;overflow:hidden}.status{box-sizing:border-box;height:28px;line-height:28px;padding:0 8px;font:12px/28px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style></head><body><div class="status">FILE_TRANSFER_NATIVE_RESOURCE</div></body></html>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color-scheme:light dark}body{margin:0;background:transparent}.image{display:none;max-width:100%;height:auto;border-radius:8px}.image.on{display:block}.status{padding:6px 8px;font:12px ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-word}</style>
<body><img id="image" class="image" alt="Uploaded image"><div id="status" class="status">VISUAL_PROOF_BRIDGE_READY</div>
<script>
const statusEl=document.getElementById('status');const imageEl=document.getElementById('image');let started='';let bridgeStarted='';let rpcSeq=0;const rpcPending=new Map();
function setStatus(v){statusEl.textContent=v;window.openai?.notifyIntrinsicHeight?.();}
function hex(bytes){return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function rpcRequest(method,params){return new Promise((resolve,reject)=>{const id='visual-proof-rpc-'+(++rpcSeq);const timer=setTimeout(()=>{rpcPending.delete(id);reject(new Error('RPC_TIMEOUT_'+method));},10000);rpcPending.set(id,{resolve,reject,timer});window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});}
async function sendProofMessage(p,label){if(!p?.resource_uri)throw new Error('RESOURCE_URI_MISSING');setStatus('VISUAL_PROOF_MESSAGE '+(label||p.file_name));const result=await rpcRequest('ui/message',{role:'user',content:[{type:'text',text:'Visual proof ready. Inspect the attached exact full-resolution image and continue the current task. File: '+p.file_name+'; bytes: '+p.bytes+'; sha256: '+p.sha256},{type:'resource_link',uri:p.resource_uri,name:p.file_name,title:p.file_name,mimeType:p.mime_type,size:p.bytes}]});if(result?.isError)throw new Error('UI_MESSAGE_REJECTED');setStatus('VISUAL_PROOF_MESSAGE_OK '+p.file_name);}
async function uploadTransfer(p,label){
 if(!p||p.direction!=='local_to_chatgpt'||!p.transfer_url)return null;
 if(typeof window.openai?.uploadFile!=='function')throw new Error('UPLOAD_FILE_UNAVAILABLE');
 setStatus('VISUAL_PROOF_UPLOAD '+(label||p.file_name));
 const r=await fetch(p.transfer_url,{cache:'no-store'});if(!r.ok)throw new Error('TRANSFER_HTTP_'+r.status);
 const data=await r.arrayBuffer();if(data.byteLength!==p.bytes)throw new Error('BYTE_COUNT_MISMATCH');
 const digest=hex(await crypto.subtle.digest('SHA-256',data));if(digest!==p.sha256)throw new Error('SHA256_MISMATCH');
 const blob=new Blob([data],{type:p.mime_type});
 if(p.mime_type.startsWith('image/')){imageEl.src=URL.createObjectURL(blob);imageEl.classList.add('on');window.openai?.notifyIntrinsicHeight?.();}
 const file=new File([blob],p.file_name,{type:p.mime_type});const out=await window.openai.uploadFile(file,{library:true});
 const fileId=out?.fileId||'';if(!fileId)throw new Error('UPLOAD_FILE_ID_MISSING');
 window.openai?.setWidgetState?.({modelContent:{visual_proof_bridge:{status:'ok',fileId,fileName:p.file_name,bytes:p.bytes,sha256:p.sha256}},privateContent:{visual_proof_bridge:{status:'ok',fileId,fileName:p.file_name,bytes:p.bytes,sha256:p.sha256}},imageIds:p.mime_type.startsWith('image/')?[fileId]:[]});
 setStatus('VISUAL_PROOF_OK '+p.file_name+' '+p.bytes+' bytes'); return fileId;
}
async function oneShot(p){const key=p?.sha256+':'+p?.transfer_url;if(!p||started===key)return;started=key;try{await uploadTransfer(p,p.file_name);}catch(e){setStatus('VISUAL_PROOF_ERROR '+String(e?.message||e));}}
async function bridgeLoop(b){
 const key=b?.next_url+':'+b?.ack_url;if(!b||!b.next_url||!b.ack_url||bridgeStarted===key)return;bridgeStarted=key;
 for(;;){
  try{
   const r=await fetch(b.next_url,{cache:'no-store'});
   if(r.status===204){await sleep(Number(b.poll_ms)||250);continue;}
   if(!r.ok)throw new Error('BRIDGE_NEXT_HTTP_'+r.status);
   const next=await r.json();if(next?.status!=='ready'||!next?.file_transfer)throw new Error('BRIDGE_NEXT_INVALID');
   await sendProofMessage(next.file_transfer,next.id||next.file_transfer.file_name);
   const ack=new URL(b.ack_url);ack.searchParams.set('id',next.id);
   const a=await fetch(ack.href,{method:'POST',cache:'no-store'});if(!a.ok)throw new Error('BRIDGE_ACK_HTTP_'+a.status);
  }catch(e){setStatus('VISUAL_PROOF_BRIDGE_ERROR '+String(e?.message||e));await sleep(1000);}
 }
}
function render(result){const p=result?._meta?.file_transfer||null;const b=result?._meta?.library_spool_bridge||null;if(p)oneShot(p);if(b)bridgeLoop(b);}
window.addEventListener('message',event=>{if(event.source!==window.parent)return;const m=event.data;if(m?.jsonrpc!=='2.0')return;if(m.id==='file-transfer-init'&&('result'in m||'error'in m)){if(!m.error)window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');return;}const pending=rpcPending.get(m.id);if(pending&&('result'in m||'error'in m)){clearTimeout(pending.timer);rpcPending.delete(m.id);if(m.error)pending.reject(new Error('RPC_ERROR_'+String(m.error?.message||m.id)));else pending.resolve(m.result||{});return;}if(m.method==='ui/notifications/tool-result')render(m.params||{});});
const envelope=window.openai?.toolResponseMetadata?.mcp_tool_result;if(envelope)render(envelope);
window.parent.postMessage({jsonrpc:'2.0',id:'file-transfer-init',method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'persistent-visual-proof-bridge',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline']}}},'*');
</script></body></html>`;
}
