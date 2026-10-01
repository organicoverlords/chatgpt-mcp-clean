import assert from "node:assert/strict";
import { MAX_READ_WAIT_MS, ProcessManager, boundReadWaitMs } from "../dist/lib/process-manager.js";
import { backendRequestTimeoutMs } from "../dist/lib/front-door-timeout.js";

assert.equal(MAX_READ_WAIT_MS, 240_000);
assert.equal(boundReadWaitMs(999_999), 240_000);
assert.equal(boundReadWaitMs(-1), 0);
assert.equal(backendRequestTimeoutMs({ tool: "read_output" }), 5_000);
assert.equal(backendRequestTimeoutMs({ tool: "read_output", waitMs: 60_000 }), 65_000);

const manager = new ProcessManager();
let started;
try {
  started = manager.startStructured(process.execPath, ["-e", "setTimeout(()=>{console.log('WAKE');setTimeout(()=>{},5000)},4500)"], undefined, "caller_immediate_read_test");

  const firstAt = Date.now();
  const first = await manager.readOutput(started.process_id, 6_000);
  const firstMs = Date.now() - firstAt;
  assert.equal(first.running, true, JSON.stringify(first));
  assert.ok(firstMs < 500, `omitted wait_ms must be immediate (${firstMs}ms)`);

  const explicitAt = Date.now();
  const explicit = await manager.readOutput(started.process_id, 6_000, 150);
  const explicitMs = Date.now() - explicitAt;
  assert.equal(explicit.running, true, JSON.stringify(explicit));
  assert.equal(explicit.no_change, true, JSON.stringify(explicit));
  assert.ok(explicitMs >= 100 && explicitMs < 1_000, `explicit wait_ms must remain honored (${explicitMs}ms)`);

  const abortReadController = new AbortController();
  const abortReadAt = Date.now();
  const abortedRead = manager.readOutput(started.process_id, 6_000, 60_000, abortReadController.signal);
  setTimeout(() => abortReadController.abort(), 50);
  await assert.rejects(abortedRead, /request_aborted/);
  const abortReadMs = Date.now() - abortReadAt;
  assert.ok(abortReadMs < 1_000, `aborted explicit read must return promptly (${abortReadMs}ms)`);

  console.log(`PASS immediate_read default_ms=${firstMs} explicit_ms=${explicitMs} abort_ms=${abortReadMs}`);
} finally {
  if (started) await manager.kill(started.process_id).catch(() => undefined);
}