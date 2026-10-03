import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, utimes, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusyStore, BusyStoreLockError } from "../dist/lib/busy-store.js";

const root = await mkdtemp(join(tmpdir(), "mcp-busy-live-lock-"));
const storePath = join(root, "busy.json");
const lockPath = storePath + ".lock";
try {
  await writeFile(lockPath, String(process.pid), "utf8");
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  const store = new BusyStore(() => false, storePath);
  const started = performance.now();
  await assert.rejects(() => store.claim("actor-a", "scope-a"), BusyStoreLockError);
  const waited = performance.now() - started;
  assert.ok(waited >= 1800, "live stale-looking lock was unexpectedly stolen");
  await unlink(lockPath);
  const claimed = await store.claim("actor-a", "scope-a");
  assert.equal(claimed.ok, true);
  console.log(JSON.stringify({ ok: true, live_lock_wait_ms: Number(waited.toFixed(1)) }));
} finally {
  await rm(root, { recursive: true, force: true });
}
