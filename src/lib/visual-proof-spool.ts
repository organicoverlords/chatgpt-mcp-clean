import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const VISUAL_PROOF_PROCESS_ID = "visual-proof";
const MARKER_PREFIX = "CHATGPT_LIBRARY_UPLOAD=";

export interface PendingVisualProof {
  manifestPath: string;
  processedPath: string;
  filePath: string;
}

function spoolRoot(): string {
  const localAppData = (process.env.LOCALAPPDATA || "").trim();
  if (!localAppData) throw new Error("LOCALAPPDATA is required for visual proof spool reads");
  return resolve(localAppData, "ChatGPTMcpFrozen", "handoff-spool");
}

function validateSpoolPath(root: string, rawPath: unknown): string {
  const filePath = resolve(String(rawPath || ""));
  if (!isAbsolute(filePath)) throw new Error("visual proof manifest path must be absolute");
  const rel = relative(root, filePath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("visual proof manifest path must stay inside the MCP handoff spool");
  }
  return filePath;
}

export function isVisualProofSnapshot(processId: string): boolean {
  return processId === VISUAL_PROOF_PROCESS_ID;
}

export async function readVisualProofSpoolBatch(maxChars: number): Promise<{ value: Record<string, unknown>; pending: PendingVisualProof[] }> {
  const root = spoolRoot();
  const queueDir = join(root, "queue");
  const processedDir = join(root, "processed");
  await mkdir(queueDir, { recursive: true });
  await mkdir(processedDir, { recursive: true });
  const names = (await readdir(queueDir)).filter((name) => name.toLowerCase().endsWith(".json")).sort();
  const pending: PendingVisualProof[] = [];
  const markers: string[] = [];
  let usedChars = 0;
  for (const name of names) {
    const manifestPath = join(queueDir, name);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const filePath = validateSpoolPath(root, manifest.path);
    const expectedBytes = Number(manifest.bytes);
    const expectedSha256 = String(manifest.sha256 || "").toLowerCase();
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) throw new Error(`invalid visual proof byte count in ${name}`);
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error(`invalid visual proof sha256 in ${name}`);
    const info = await stat(filePath);
    if (!info.isFile() || info.size !== expectedBytes) throw new Error(`visual proof size mismatch in ${name}`);
    const bytes = await readFile(filePath);
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== expectedSha256) throw new Error(`visual proof sha256 mismatch in ${name}`);
    const marker = `${MARKER_PREFIX}${filePath}\n`;
    if (pending.length > 0 && usedChars + marker.length > maxChars) break;
    usedChars += marker.length;
    markers.push(marker.trimEnd());
    pending.push({ manifestPath, processedPath: join(processedDir, name), filePath });
  }
  return {
    value: {
      mcp_status: "OK",
      process_state: "SNAPSHOT",
      elapsed_ms: 0,
      next_action: "READ_SAME_PROCESS_ID",
      process_id: VISUAL_PROOF_PROCESS_ID,
      running: true,
      stdout: markers.length ? `${markers.join("\n")}\n` : "",
      stderr: "",
      ...(markers.length ? {} : { no_change: true }),
      snapshot_alias: true,
    },
    pending,
  };
}

export async function acknowledgeVisualProofSpoolBatch(pending: PendingVisualProof[]): Promise<void> {
  for (const item of pending) await rename(item.manifestPath, item.processedPath);
}
