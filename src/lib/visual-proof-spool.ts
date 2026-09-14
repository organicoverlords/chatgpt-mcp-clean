import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const VISUAL_PROOF_PROCESS_ID = "visual-proof";
const MARKER_PREFIX = "CHATGPT_LIBRARY_UPLOAD=";

export interface PendingVisualProof {
  id: string;
  manifestPath: string;
  processedPath: string;
  filePath: string;
  claimDirectory?: string;
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

export async function waitForVisualProofSpoolItem(signal?: AbortSignal): Promise<boolean> {
  const queueDir = join(spoolRoot(), "queue");
  await mkdir(queueDir, { recursive: true });
  const hasManifest = async () => (await readdir(queueDir)).some((name) => name.toLowerCase().endsWith(".json"));
  if (await hasManifest()) return true;

  return new Promise<boolean>((resolvePromise, rejectPromise) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    const onAbort = () => finish(false);
    const finish = (ready: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      watcher?.close();
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(ready);
    };
    const check = () => {
      void hasManifest().then((ready) => { if (ready) finish(true); }).catch((error) => finish(false, error));
    };

    if (signal?.aborted) { finish(false); return; }
    try {
      watcher = watch(queueDir, { persistent: false }, (_eventType, filename) => {
        if (!filename || String(filename).toLowerCase().endsWith(".json")) check();
      });
      watcher.on("error", (error) => finish(false, error));
      signal?.addEventListener("abort", onAbort, { once: true });
      // Recheck after the watcher is installed to close the create-between-check-and-watch race.
      check();
    } catch (error) {
      finish(false, error);
    }
  });
}

async function pendingFromManifest(root: string, id: string, manifestPath: string, processedPath: string): Promise<PendingVisualProof> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const filePath = validateSpoolPath(root, manifest.path);
  const expectedBytes = Number(manifest.bytes);
  const expectedSha256 = String(manifest.sha256 || "").toLowerCase();
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) throw new Error(`invalid visual proof byte count in ${id}`);
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error(`invalid visual proof sha256 in ${id}`);
  const info = await stat(filePath);
  if (!info.isFile() || info.size !== expectedBytes) throw new Error(`visual proof size mismatch in ${id}`);
  const bytes = await readFile(filePath);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) throw new Error(`visual proof sha256 mismatch in ${id}`);
  return { id, manifestPath, processedPath, filePath };
}

const CLAIM_OWNER_FILE = "owner.meta";
const CLAIM_OWNER_WRITE_GRACE_MS = 30_000;

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === "EPERM"; }
}

async function recoverAbandonedVisualProofClaims(root: string): Promise<void> {
  const queueDir = join(root, "queue");
  const claimedRoot = join(root, "claimed");
  await mkdir(queueDir, { recursive: true });
  await mkdir(claimedRoot, { recursive: true });
  const entries = await readdir(claimedRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".claim")) continue;
    const claimDir = join(claimedRoot, entry.name);
    let owner: { pid?: number; claimedAt?: number } | undefined;
    try { owner = JSON.parse(await readFile(join(claimDir, CLAIM_OWNER_FILE), "utf8")); } catch {}
    if (owner?.pid && processIsAlive(owner.pid)) continue;
    if (!owner) {
      const info = await stat(claimDir);
      if (Date.now() - info.mtimeMs < CLAIM_OWNER_WRITE_GRACE_MS) continue;
    }
    const manifests = (await readdir(claimDir)).filter((name) => name.toLowerCase().endsWith(".json"));
    for (const name of manifests) {
      const source = join(claimDir, name);
      let target = join(queueDir, name);
      try {
        await stat(target);
        target = join(queueDir, `recovered-${Date.now()}-${randomUUID()}-${name}`);
      } catch {}
      await rename(source, target);
    }
    await rm(claimDir, { recursive: true, force: true });
  }
}

export async function claimVisualProofSpoolItem(): Promise<PendingVisualProof | undefined> {
  const root = spoolRoot();
  const queueDir = join(root, "queue");
  const claimedRoot = join(root, "claimed");
  const processedDir = join(root, "processed");
  await mkdir(queueDir, { recursive: true });
  await mkdir(claimedRoot, { recursive: true });
  await mkdir(processedDir, { recursive: true });
  await recoverAbandonedVisualProofClaims(root);
  const names = (await readdir(queueDir)).filter((name) => name.toLowerCase().endsWith(".json")).sort();
  for (const name of names) {
    const source = join(queueDir, name);
    const claimDir = join(claimedRoot, `${name}.claim`);
    try {
      // A fixed claim directory is the cross-process exclusion primitive. On Windows,
      // concurrent rename(source, distinctDestinations) is not sufficient for exclusive
      // ownership, while mkdir on the same path reliably gives one winner.
      await mkdir(claimDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") continue;
      throw error;
    }
    try {
      await writeFile(join(claimDir, CLAIM_OWNER_FILE), JSON.stringify({ pid: process.pid, claimedAt: Date.now() }), "utf8");
      const claimed = join(claimDir, name);
      try {
        await rename(source, claimed);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        await rm(claimDir, { recursive: true, force: true });
        if (code === "ENOENT" || code === "EACCES" || code === "EPERM") continue;
        throw error;
      }
      try {
        const proof = await pendingFromManifest(root, name, claimed, join(processedDir, name));
        return { ...proof, claimDirectory: claimDir };
      } catch (error) {
        try { await rename(claimed, source); } catch {}
        await rm(claimDir, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      try { await rm(claimDir, { recursive: true, force: true }); } catch {}
      throw error;
    }
  }
  return undefined;
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
    const proof = await pendingFromManifest(root, name, manifestPath, join(processedDir, name));
    const marker = `${MARKER_PREFIX}${proof.filePath}\n`;
    if (pending.length > 0 && usedChars + marker.length > maxChars) break;
    usedChars += marker.length;
    markers.push(marker.trimEnd());
    pending.push(proof);
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
  for (const item of pending) {
    try {
      await rename(item.manifestPath, item.processedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        try {
          const info = await stat(item.processedPath);
          if (info.isFile()) {
            if (item.claimDirectory) await rm(item.claimDirectory, { recursive: true, force: true });
            continue;
          }
        } catch {}
      }
      throw error;
    }
    if (item.claimDirectory) await rm(item.claimDirectory, { recursive: true, force: true });
  }
}
