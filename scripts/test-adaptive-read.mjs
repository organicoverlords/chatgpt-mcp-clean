import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager();
let started;
try {
  started = manager.start("Start-Sleep -Milliseconds 4500; Write-Output 'ADAPTIVE_WAKE'; Start-Sleep -Seconds 5", undefined, "caller_adaptive_read_test");
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
  console.log(`PASS adaptive_read first_ms=${firstMs} second_ms=${secondMs} reset_ms=${resetMs} explicit_ms=${explicitMs}`);
} finally {
  if (started) await manager.kill(started.process_id).catch(() => undefined);
}
