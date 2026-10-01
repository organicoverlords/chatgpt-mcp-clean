import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

export const MAX_MODEL_IMAGE_BYTES_EXCLUSIVE = 10 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function normalized(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function configuredRoots(): string[] {
  const explicit = (process.env.MCP_IMAGE_ROOTS || "")
    .split(process.platform === "win32" ? ";" : ":")
    .map((value) => value.trim())
    .filter(Boolean);
  if (explicit.length > 0) return explicit.map((value) => resolve(value));
  if (process.platform !== "win32") return ["/mnt/ue"];
  const profile = process.env.USERPROFILE || process.cwd();
  return [
    join(profile, "Pictures"),
    join(profile, "Downloads"),
    join(profile, "Desktop"),
    join(profile, "Documents"),
    join(profile, "AppData", "Local", "Temp"),
    join(profile, "AppData", "Local", "AgentWorktrees"),
  ].map((value) => resolve(value));
}

function isWithinRoot(path: string, root: string): boolean {
  const rel = relative(normalized(root), normalized(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function inspectLocalImage(input: string): Promise<{ data: string; mimeType: string; bytes: number }> {
  if (!isAbsolute(input)) throw new Error("image path must be absolute");
  const path = resolve(input);
  const mimeType = MIME_TYPES[extname(path).toLowerCase()];
  if (!mimeType) throw new Error("unsupported image type; use PNG, JPEG, GIF, or WebP");
  if (!configuredRoots().some((root) => isWithinRoot(path, root))) throw new Error("image path is outside the configured inspection roots");
  const info = await stat(path);
  if (!info.isFile()) throw new Error("image path is not a file");
  if (info.size >= MAX_MODEL_IMAGE_BYTES_EXCLUSIVE) {
    throw new Error(`image is ${info.size} bytes; model inspection requires strictly less than ${MAX_MODEL_IMAGE_BYTES_EXCLUSIVE} bytes`);
  }
  const data = await readFile(path);
  return { data: data.toString("base64"), mimeType, bytes: info.size };
}
