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

export const FILE_TRANSFER_WIDGET_URI = "ui://process/file-transfer-v1.html";
const LOCAL_EXPORT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const ZSTD_MIN_BYTES = 64 * 1024;
const MAX_REDIRECTS = 4;
const MAX_REVIEW_ZIP_ENTRIES = 512;
const MAX_REVIEW_ZIP_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_REVIEW_MANIFEST_BYTES = 1024 * 1024;
const REVIEW_ZIP_SCHEMAS = new Set(["lowvram.visual-review-transfer.v1", "p3.visual-review-transfer.v1"]);

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
  file_name: z.string(),
  mime_type: z.string(),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
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
  expires_at: number;
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
  expires_at: number;
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

function cleanupExpired(now = Date.now()): void {
  for (const [token, item] of localExports) if (item.expires_at <= now) localExports.delete(token);
  for (const [token, item] of localImageResources) if (item.expires_at <= now) localImageResources.delete(token);
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
  cleanupExpired();
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
    expires_at: Date.now() + LOCAL_EXPORT_TTL_MS,
  };
  localExports.set(item.token, item);
  if (item.mime_type.startsWith("image/")) {
    localImageResources.set(item.token, {
      token: item.token, source_path: item.path, source_bytes: item.bytes, source_mtime_ms: item.mtime_ms,
      file_name: item.file_name, mime_type: item.mime_type, bytes: item.bytes, sha256: item.sha256, expires_at: item.expires_at,
    });
  }
  return item;
}

function localTransferMeta(item: LocalFileTransfer) {
  return {
    direction: "local_to_chatgpt",
    phase: "ready",
    transfer_url: localTransferUrl(item.token),
    file_name: item.file_name,
    mime_type: item.mime_type,
    bytes: item.bytes,
    sha256: item.sha256,
  };
}

function localImageResourceUri(item: LocalImageResource): string {
  return `mcp-upload://file-transfer/${item.token}`;
}

function localImageResourceLink(item: LocalImageResource) {
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
  if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > MAX_REVIEW_ZIP_ENTRIES - 1) throw new Error("visual review ZIP manifest has invalid files array");

  const declared = new Set<string>();
  const resources: LocalImageResource[] = [];
  for (const raw of manifest.files) {
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
      expires_at: item.expires_at,
      data_offset: await storedZipDataOffset(item.path, item.bytes, entry),
    };
    localImageResources.set(token, resource);
    resources.push(resource);
  }
  if (entries.size !== declared.size + 1 || [...entries.keys()].some((name) => name !== "manifest.json" && !declared.has(name))) throw new Error("visual review ZIP contains undeclared members");
  return resources;
}

async function localImageResourceContents(uri: string) {
  cleanupExpired();
  const parsed = new URL(uri);
  if (parsed.protocol !== "mcp-upload:" || parsed.hostname !== "file-transfer") throw new Error("unsupported file-transfer image resource URI");
  const token = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const item = localImageResources.get(token);
  if (!item) throw new Error("file-transfer image resource is unavailable or expired");
  const current = await stat(item.source_path).catch(() => null);
  if (!current?.isFile() || current.size !== item.source_bytes || current.mtimeMs !== item.source_mtime_ms) {
    localImageResources.delete(token);
    throw new Error("source image container changed after transfer preparation");
  }
  let data: Buffer;
  if (item.data_offset === undefined) {
    data = await readFile(item.source_path);
  } else {
    const handle = await open(item.source_path, "r");
    try { data = await readExactly(handle, item.bytes, item.data_offset); }
    finally { await handle.close(); }
  }
  if (data.length !== item.bytes) throw new Error("source image size changed while reading");
  const digest = createHash("sha256").update(data).digest("hex");
  if (digest !== item.sha256) throw new Error("source image hash changed while reading");
  return { uri, mimeType: item.mime_type, blob: data.toString("base64") };
}

function zstdStream() {
  return createZstdCompress({ params: { [zlibConstants.ZSTD_c_compressionLevel]: 1 } });
}

export async function serveLocalFileTransfer(req: Request, res: ExpressResponse): Promise<void> {
  cleanupExpired();
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const item = token ? localExports.get(token) : undefined;
  if (!item) {
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
  // Capability URLs are single-use after a complete transfer. A failed stream can
  // be retried until its short TTL expires, but a successful fetch cannot be replayed.
  localExports.delete(token);
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

function widgetResourceMeta() {
  let origin = "";
  try { origin = publicOrigin().origin; } catch { origin = ""; }
  const connectDomains = origin ? [origin] : [];
  return {
    ui: { prefersBorder: false, csp: { connectDomains, resourceDomains: [] } },
    "openai/widgetDescription": "Exact-byte local file upload into ChatGPT/Library.",
    "openai/widgetPrefersBorder": false,
    "openai/widgetCSP": { connect_domains: connectDomains, resource_domains: [] },
  };
}

function uploadToolMeta() {
  return {
    ui: { resourceUri: FILE_TRANSFER_WIDGET_URI, visibility: ["model", "app"] },
    "openai/outputTemplate": FILE_TRANSFER_WIDGET_URI,
  };
}

export function registerFileTransferTools(server: McpServer, callerId: string): void {
  server.registerResource(
    "file-transfer-image",
    new ResourceTemplate("mcp-upload://file-transfer/{token}", { list: undefined }),
    { title: "Exact uploaded image", description: "Original local image bytes exposed for immediate model vision" },
    async (uri) => ({ contents: [await localImageResourceContents(uri.href)] }),
  );
  server.registerResource("process-file-transfer-widget", FILE_TRANSFER_WIDGET_URI, {}, async () => ({
    contents: [{
      uri: FILE_TRANSFER_WIDGET_URI,
      mimeType: "text/html;profile=mcp-app",
      text: fileTransferWidgetHtml(),
      _meta: widgetResourceMeta(),
    }],
  }));

  server.registerTool(
    "upload_local_file",
    {
      description: "Upload one exact local file from the MCP host into ChatGPT/Library. Transfers raw bytes through a dedicated short-lived endpoint instead of embedding file data in process output. HTTP zstd level 1 is used opportunistically for compressible formats when the client advertises support; already-compressed media is streamed unchanged.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: uploadToolMeta(),
      inputSchema: z.object({ path: z.string().min(1) }),
      outputSchema: UploadLocalFileOutputSchema,
    },
    async ({ path }) => {
      const item = await prepareLocalFileTransfer(path);
      const directImage = item.mime_type.startsWith("image/") ? localImageResources.get(item.token) : undefined;
      const reviewImages = directImage ? [directImage] : await visualReviewZipResources(item);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ caller_id: callerId, status: "ready", file_name: item.file_name, mime_type: item.mime_type, bytes: item.bytes, sha256: item.sha256 }) },
          ...reviewImages.map(localImageResourceLink),
        ],
        structuredContent: { direction: "local_to_chatgpt", status: "ready", file_name: item.file_name, mime_type: item.mime_type, bytes: item.bytes, sha256: item.sha256 },
        _meta: { file_transfer: localTransferMeta(item) },
      };
    },
  );

  server.registerTool(
    "download_chatgpt_file",
    {
      description: "Save one exact ChatGPT file onto the MCP host without transcoding. Pass the ChatGPT file in file and an absolute destination_path; overwrite defaults to false. The server streams the temporary ChatGPT download URL directly to disk and returns byte count plus SHA-256.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { "openai/fileParams": ["file"] },
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
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color-scheme:light dark}body{margin:0;background:transparent}.image{display:none;max-width:100%;height:auto;border-radius:8px}.image.on{display:block}.status{padding:6px 8px;font:12px ui-monospace,SFMono-Regular,Consolas,monospace;word-break:break-word}</style>
<body><img id="image" class="image" alt="Uploaded image"><div id="status" class="status">FILE_TRANSFER_READY</div>
<script>
const statusEl=document.getElementById('status');const imageEl=document.getElementById('image');let started='';
function setStatus(v){statusEl.textContent=v;window.openai?.notifyIntrinsicHeight?.();}
function hex(bytes){return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');}
function payload(result){return result?._meta?.file_transfer||null;}
async function render(result){
 const p=payload(result);if(!p||p.direction!=='local_to_chatgpt'||!p.transfer_url)return;
 const key=p.sha256+':'+p.transfer_url;if(started===key)return;started=key;setStatus('FILE_TRANSFER_RUNNING '+p.file_name);
 try{
  if(typeof window.openai?.uploadFile!=='function')throw new Error('UPLOAD_FILE_UNAVAILABLE');
  const r=await fetch(p.transfer_url,{cache:'no-store'});if(!r.ok)throw new Error('TRANSFER_HTTP_'+r.status);
  const data=await r.arrayBuffer();if(data.byteLength!==p.bytes)throw new Error('BYTE_COUNT_MISMATCH');
  const digest=hex(await crypto.subtle.digest('SHA-256',data));if(digest!==p.sha256)throw new Error('SHA256_MISMATCH');
   const blob=new Blob([data],{type:p.mime_type});
   if(p.mime_type.startsWith('image/')){imageEl.src=URL.createObjectURL(blob);imageEl.classList.add('on');window.openai?.notifyIntrinsicHeight?.();}
   const file=new File([blob],p.file_name,{type:p.mime_type});const out=await window.openai.uploadFile(file,{library:true});
  const fileId=out?.fileId||'';if(!fileId)throw new Error('UPLOAD_FILE_ID_MISSING');
  window.openai?.setWidgetState?.({modelContent:{file_transfer:{status:'ok',direction:'local_to_chatgpt',fileId,fileName:p.file_name,bytes:p.bytes,sha256:p.sha256}},privateContent:{file_transfer:{status:'ok',fileId,fileName:p.file_name,bytes:p.bytes,sha256:p.sha256}},imageIds:p.mime_type.startsWith('image/')?[fileId]:[]});
  setStatus('FILE_TRANSFER_OK '+p.file_name+' '+p.bytes+' bytes');
 }catch(e){setStatus('FILE_TRANSFER_ERROR '+String(e?.message||e));}
}
window.addEventListener('message',event=>{if(event.source!==window.parent)return;const m=event.data;if(m?.jsonrpc!=='2.0')return;if(m.id==='file-transfer-init'&&('result'in m||'error'in m)){if(!m.error)window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');return;}if(m.method==='ui/notifications/tool-result')render(m.params||{});});
const envelope=window.openai?.toolResponseMetadata?.mcp_tool_result;if(envelope)render(envelope);
window.parent.postMessage({jsonrpc:'2.0',id:'file-transfer-init',method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'process-file-transfer',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline']}}},'*');
</script></body></html>`;
}
