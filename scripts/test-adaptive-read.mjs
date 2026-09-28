import assert from "node:assert/strict";
import { ADAPTIVE_READ_WAIT_MS, MAX_READ_WAIT_MS, ProcessManager, adaptiveReadWaitMs, boundReadWaitMs } from "../dist/lib/process-manager.js";


assert.equal(MAX_READ_WAIT_MS, 240_000);
assert.deepEqual(ADAPTIVE_READ_WAIT_MS, [2_000, 5_000, 10_000, 30_000, 60_000]);
assert.equal(boundReadWaitMs(999_999), 240_000);
assert.equal(boundReadWaitMs(-1), 0);
assert.equal(adaptiveReadWaitMs(0), 2_000);
assert.equal(adaptiveReadWaitMs(3), 30_000);
assert.equal(adaptiveReadWaitMs(4), 60_000);
assert.equal(adaptiveReadWaitMs(99), 60_000);

const manager = new ProcessManager();
let started;
let paged;
try {
  started = manager.startStructured(process.execPath, ["-e", "setTimeout(()=>{console.log(\"ADAPTIVE_WAKE\");setTimeout(()=>{},5000)},4500)"], undefined, "caller_adaptive_read_test");
  const firstAt = Date.now();
  const first = await manager.readOutput(started.process_id, 6_000);
  const firstMs = Date.now() - firstAt;
  assert.equal(first.running, true, JSON.stringify(first));
  assert.equal(first.no_change, true, JSON.stringify(first));
  assert.ok(firstMs >= 1_700 && firstMs < 3_500, `first implicit read should use the short wait band (${firstMs}ms)`);

  const secondAt = Date.now();
  const second = await manager.readOutput(started.process_id, 6_000);
  const secondMs = Date.now() - secondAt;
  assert.match(second.stdout, /ADAPTIVE_WAKE/, JSON.stringify(second));
  assert.ok(secondMs >= 1_900 && secondMs < 4_500, `second implicit read should remain blocked past 2s and wake on output (${secondMs}ms)`);

  const resetAt = Date.now();
  const reset = await manager.readOutput(started.process_id, 6_000);
  const resetMs = Date.now() - resetAt;
  assert.equal(reset.running, true, JSON.stringify(reset));
  assert.equal(reset.no_change, true, JSON.stringify(reset));
  assert.ok(resetMs >= 1_700 && resetMs < 3_500, `output should reset implicit wait to the short band (${resetMs}ms)`);

  const explicitAt = Date.now();
  const explicit = await manager.readOutput(started.process_id, 6_000, 150);
  const explicitMs = Date.now() - explicitAt;
  assert.equal(explicit.running, true, JSON.stringify(explicit));
  assert.equal(explicit.no_change, true, JSON.stringify(explicit));
  assert.ok(explicitMs >= 100 && explicitMs < 1_000, `explicit wait_ms must bypass adaptive timing (${explicitMs}ms)`);
  paged = manager.startStructured(process.execPath, ["-e", "process.stdout.write('X'.repeat(10000)); setTimeout(()=>{},10000)"], undefined, "caller_adaptive_page_test");
  const pageOne = await manager.readWithWait(paged.process_id, 200, 2_000);
  assert.equal(pageOne.output_page?.more, true, JSON.stringify(pageOne));
  const pageTwoAt = Date.now();
  const pageTwo = await manager.readOutput(paged.process_id, 200);
  const pageTwoMs = Date.now() - pageTwoAt;
  assert.equal(pageTwo.output_page?.stdout_start, 200, JSON.stringify(pageTwo));
  assert.equal(pageTwo.stdout.length, 200);
  assert.ok(pageTwoMs < 500, `already-spooled next page must return immediately (${pageTwoMs}ms)`);
  console.log(`PASS adaptive_read first_ms=${firstMs} second_ms=${secondMs} reset_ms=${resetMs} explicit_ms=${explicitMs} buffered_page_ms=${pageTwoMs}`);
} finally {
  if (started) await manager.kill(started.process_id).catch(() => undefined);
  if (paged) await manager.kill(paged.process_id).catch(() => undefined);
}
