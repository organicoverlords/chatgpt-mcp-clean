import path from "node:path";
import fs from "node:fs/promises";

export async function resolvePath(input: string): Promise<string> {
  if (!input?.trim()) throw new Error("path is required");
  const p = path.resolve(input);
  return p;
}
export async function ensureParent(p: string) { await fs.mkdir(path.dirname(p), { recursive: true }); }
