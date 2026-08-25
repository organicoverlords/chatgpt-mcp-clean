import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve, sep } from "node:path";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function imageRoots(): string[] {
  const profile = process.env.USERPROFILE || process.cwd();
  const configured = (process.env.MCP_IMAGE_ROOTS || "")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  const defaults = [
    join(profile, "Pictures"),
    join(profile, "Downloads"),
    join(profile, "Desktop"),
    join(profile, "Documents", "Codex"),
    join(profile, "AppData", "Local", "Temp"),
  ];
  return [...new Set([...configured, ...defaults].map((root) => resolve(root)))];
}

function allowedImagePath(input: string): { path: string; mimeType: string } {
  if (!isAbsolute(input)) throw new Error("image path must be absolute");
  const path = resolve(input);
  const mimeType = MIME_TYPES[extname(path).toLowerCase()];
  if (!mimeType) throw new Error("unsupported image type; use PNG, JPEG, GIF, or WebP");
  if (!imageRoots().some((root) => path === root || path.startsWith(`${root}${sep}`))) {
    throw new Error("image path is outside the allowed image roots");
  }
  return { path, mimeType };
}

export async function viewImage(input: string) {
  const { path, mimeType } = allowedImagePath(input);
  const info = await stat(path);
  if (!info.isFile()) throw new Error("image path is not a file");
  if (info.size > MAX_IMAGE_BYTES) throw new Error(`image exceeds the ${MAX_IMAGE_BYTES} byte limit`);
  const data = await readFile(path);
  return {
    content: [{ type: "image" as const, data: data.toString("base64"), mimeType }],
  };
}
