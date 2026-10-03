import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "../dist/lib/process-manager.js";

const source = await readFile(new URL("../src/lib/process-manager.ts", import.meta.url), "utf8");
assert.doesNotMatch(source, /CONTROL_POLL_MS/);
assert.match(source, /waitForControlResponse/);
assert.match(source, /watch\(directory/);

const receipts = await mkdtemp(join(tmpdir(), "mcp-control-watch-"));
const owner = new ProcessManager({ maxLiveTotal: 4, receiptDirectory: receipts });
const reader = new ProcessManager({ maxLiveTotal: 4, receiptDirectory: receipts });
try {
  const started = owner.startStructured(
    process.execPath,
    ["-e", "setTimeout(()=>{console.log('HANDOFF_WATCH_OK');},200);setTimeout(()=>process.exit(0),350)"],
    undefined,
    "handoff-owner",
  );
  const at = performance.now();
  const result = await reader.readOutput(started.process_id, 30_000, 2_000);
  const elapsed = performance.now() - at;
  assert.equal(result.process_id, started.process_id);
  assert.match(String(result.stdout), /HANDOFF_WATCH_OK/);
  assert.ok(elapsed < 1500, "watch handoff exceeded bound: " + elapsed.toFixed(1) + "ms");
  console.log(JSON.stringify({ ok: true, handoff_ms: Number(elapsed.toFixed(1)), polling: false }));
} finally {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(receipts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exit(0);
