import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const localAppData = (process.env.LOCALAPPDATA || "").trim();
if (!localAppData) throw new Error("LOCALAPPDATA is required");
const pollMs = Math.max(25, Math.min(2_000, Number(process.env.MCP_VISUAL_SPOOL_POLL_MS || 100)));
const spoolRoot = resolve(localAppData, "ChatGPTMcpFrozen", "handoff-spool");
const queueDir = join(spoolRoot, "queue");
const processedDir = join(spoolRoot, "processed");
await mkdir(queueDir, { recursive: true });
await mkdir(processedDir, { recursive: true });

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

function validateSpoolPath(rawPath) {
  const filePath = resolve(String(rawPath || ""));
  if (!isAbsolute(filePath)) throw new Error("visual proof manifest path must be absolute");
  const rel = relative(spoolRoot, filePath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("visual proof manifest path must stay inside the MCP handoff spool");
  }
  return filePath;
}

async function flushMarker(filePath) {
  await new Promise((resolveWrite, rejectWrite) => {
    process.stdout.write(`CHATGPT_LIBRARY_UPLOAD=${filePath}\n`, (error) => error ? rejectWrite(error) : resolveWrite());
  });
}

async function processManifest(name) {
  const manifestPath = join(queueDir, name);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const filePath = validateSpoolPath(manifest.path);
  const expectedBytes = Number(manifest.bytes);
  const expectedSha256 = String(manifest.sha256 || "").toLowerCase();
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) throw new Error(`invalid bytes in ${name}`);
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error(`invalid sha256 in ${name}`);
  const info = await stat(filePath);
  if (!info.isFile() || info.size !== expectedBytes) throw new Error(`visual proof size mismatch in ${name}`);
  const data = await readFile(filePath);
  const actualSha256 = createHash("sha256").update(data).digest("hex");
  if (actualSha256 !== expectedSha256) throw new Error(`visual proof sha256 mismatch in ${name}`);
  await flushMarker(filePath);
  await rename(manifestPath, join(processedDir, name));
}

process.stdout.write("VISUAL_PROOF_WATCHER_READY\n");
while (!stopping) {
  const names = (await readdir(queueDir)).filter((name) => name.toLowerCase().endsWith(".json")).sort();
  for (const name of names) {
    if (stopping) break;
    try {
      await processManifest(name);
    } catch (error) {
      process.stderr.write(`VISUAL_PROOF_WATCHER_ERROR ${name} ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
}
