import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
process.env.MCP_TEST_LAUNCH_DELAY_MS = "3000";
const manager = new ProcessManager({ maxLivePerCaller: 5 });

const startedAt = performance.now();
const started = manager.start("Write-Output SPAWN_ISOLATION_OK", undefined, "spawn-isolation-test");
const startReturnMs = performance.now() - startedAt;
assert.ok(startReturnMs < 250, `start() blocked main thread for ${startReturnMs.toFixed(1)}ms`);
assert.equal(started.running, true);
assert.equal(started.launching, true);

const timerAt = performance.now();
await sleep(100);
const timerMs = performance.now() - timerAt;
assert.ok(timerMs < 500, `event loop blocked while worker spawn stalled: ${timerMs.toFixed(1)}ms`);

const during = manager.read(started.process_id);
assert.equal(during.running, true);
assert.equal(during.process_id, started.process_id);
let final = during;
const deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  await sleep(100);
  final = manager.read(started.process_id);
  if (final.running === false) break;
}
assert.equal(final.running, false, "isolated launch eventually completes");
assert.match(final.stdout, /SPAWN_ISOLATION_OK/);
assert.ok(Number(final.pid) > 0, `expected real child pid, got ${final.pid}`);

console.log(JSON.stringify({
  ok: true,
  start_return_ms: Number(startReturnMs.toFixed(1)),
  event_loop_timer_ms: Number(timerMs.toFixed(1)),
  child_pid: final.pid,
  exit_code: final.exit_code,
}));
