import assert from "node:assert/strict";
import { MAX_READ_CHARS, ProcessManager } from "../dist/lib/process-manager.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForExit(manager, processId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = manager.read(processId);
    if (!state.running) return state;
    await sleep(10);
  }
  throw new Error(`process ${processId} did not exit during the test`);
}

assert.equal(MAX_READ_CHARS, 6_000);
const manager = new ProcessManager({ maxLaunchesPerWindow: 8 });
const started = [];
try {
  const windowJob = manager.start("Write-Output ('WINDOW_BEGIN_' + ('W' * 24000) + '_WINDOW_END')");
  started.push(windowJob.process_id);
  const windowOutput = await waitForExit(manager, windowJob.process_id);
  assert.equal(windowOutput.stdout_truncated, true);
  assert.ok(windowOutput.stdout.length <= MAX_READ_CHARS);
  assert.ok(windowOutput.stdout_dropped_from_start > 0);
  assert.doesNotMatch(windowOutput.stdout, /^WINDOW_BEGIN_/);
  assert.match(windowOutput.stdout, /_WINDOW_END\r?\n?$/);

  const floodJob = manager.start("$payload = 'X' * 200; 1..500 | ForEach-Object { Write-Output (('FLOOD_{0}_{1}' -f $_,$payload)) }");
  started.push(floodJob.process_id);
  const floodOutput = await waitForExit(manager, floodJob.process_id);
  assert.equal(floodOutput.stdout_truncated, true);
  assert.ok(floodOutput.stdout.length <= MAX_READ_CHARS);
  assert.ok(floodOutput.stdout_dropped_from_start > 0);
  assert.match(floodOutput.stdout, /FLOOD_500_/);
  console.log(`PASS read_window bounded=${MAX_READ_CHARS} window=${windowOutput.stdout.length} flood=${floodOutput.stdout.length}`);
} finally {
  for (const processId of started) await manager.kill(processId).catch(() => undefined);
}
