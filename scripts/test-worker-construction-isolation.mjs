import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
process.env.MCP_TEST_WORKER_CONSTRUCTION_DELAY_MS = "3000";

const constructorAt = performance.now();
const manager = new ProcessManager({ maxLivePerCaller: 5 });
const constructorMs = performance.now() - constructorAt;
delete process.env.MCP_TEST_WORKER_CONSTRUCTION_DELAY_MS;

assert.ok(constructorMs > 2500, `worker-construction delay injection did not run: ${constructorMs.toFixed(1)}ms`);

const startAt = performance.now();
const first = manager.start("Write-Output WARM_WORKER_ONE", undefined, "worker-construction-test");
const second = manager.start("Write-Output WARM_WORKER_TWO", undefined, "worker-construction-test");
const startMs = performance.now() - startAt;
assert.ok(startMs < 1500, `start() inherited the injected 3s worker-construction stall: ${startMs.toFixed(1)}ms`);
assert.equal(first.launching, true);
assert.equal(second.launching, true);

const timerAt = performance.now();
await sleep(100);
const timerMs = performance.now() - timerAt;
assert.ok(timerMs < 500, `event loop blocked after warm launcher startup: ${timerMs.toFixed(1)}ms`);
let firstFinal = manager.read(first.process_id);
let secondFinal = manager.read(second.process_id);
const deadline = Date.now() + 8000;
while (Date.now() < deadline && (firstFinal.running || secondFinal.running)) {
  await sleep(100);
  firstFinal = manager.read(first.process_id);
  secondFinal = manager.read(second.process_id);
}
assert.equal(firstFinal.running, false, JSON.stringify(firstFinal));
assert.equal(secondFinal.running, false, JSON.stringify(secondFinal));
assert.match(firstFinal.stdout, /WARM_WORKER_ONE/);
assert.match(secondFinal.stdout, /WARM_WORKER_TWO/);
assert.ok(Number(firstFinal.pid) > 0);
assert.ok(Number(secondFinal.pid) > 0);

console.log(JSON.stringify({
  ok: true,
  constructor_ms: Number(constructorMs.toFixed(1)),
  two_start_calls_ms: Number(startMs.toFixed(1)),
  event_loop_timer_ms: Number(timerMs.toFixed(1)),
  pids: [firstFinal.pid, secondFinal.pid],
}));
