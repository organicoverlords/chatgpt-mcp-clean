import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "../dist/lib/process-manager.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForExit(manager, processId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = manager.read(processId);
    if (!state.running) return state;
    await sleep(10);
  }
  throw new Error(`process ${processId} did not exit during the test`);
}

const observabilityManager = new ProcessManager();
let observabilityProcess;
try {
  observabilityProcess = observabilityManager.start("Start-Sleep -Milliseconds 500; Write-Output 'OBSERVABILITY_OK'", undefined, "caller_observability_test");
  assert.equal(observabilityProcess.mcp_status, "OK");
  assert.equal(observabilityProcess.process_state, "RUNNING");
  assert.equal(observabilityProcess.next_action, "READ_SAME_PROCESS_ID");
  assert.equal(observabilityProcess.running, true);
  assert.ok(Number.isInteger(observabilityProcess.elapsed_ms) && observabilityProcess.elapsed_ms >= 0);

  const running = observabilityManager.read(observabilityProcess.process_id);
  assert.equal(running.mcp_status, "OK");
  assert.equal(running.process_state, "RUNNING");
  assert.equal(running.next_action, "READ_SAME_PROCESS_ID");
  assert.equal(running.running, true);
  assert.ok(Number.isInteger(running.elapsed_ms) && running.elapsed_ms >= 0);

  const completed = await waitForExit(observabilityManager, observabilityProcess.process_id);
  assert.equal(completed.mcp_status, "OK");
  assert.equal(completed.process_state, "COMPLETED");
  assert.equal(completed.next_action, "STOP_READING");
  assert.equal(completed.running, false);
  assert.ok(Number.isInteger(completed.elapsed_ms) && completed.elapsed_ms >= 0);
} finally {
  if (observabilityProcess) await observabilityManager.kill(observabilityProcess.process_id).catch(() => undefined);
}

const manager = new ProcessManager({ maxLaunchesPerWindow: 2 });
const callerId = "caller_rate_guard_test";
let rejected;

for (let index = 1; index <= 3; index += 1) {
  try {
    const started = manager.start(`Write-Output 'RATE_${index}'`, undefined, callerId);
    await waitForExit(manager, started.process_id);
  } catch (error) {
    rejected = error;
    break;
  }
}

assert.ok(rejected instanceof Error, "the launch after the per-caller limit must be rejected");
assert.match(rejected.message, /start_process_rate_limited/);

let fakeNow = 1_000_000;
const refillManager = new ProcessManager({
  maxLaunchesPerWindow: 2,
  launchRefillMs: 5_000,
  now: () => fakeNow,
});
for (let index = 1; index <= 2; index += 1) {
  const started = refillManager.start(`Write-Output 'REFILL_${index}'`, undefined, "caller_refill_test");
  await waitForExit(refillManager, started.process_id);
}
fakeNow += 5_000;
let refillError;
let refilledProcess;
try {
  refilledProcess = refillManager.start("Write-Output 'REFILLED'", undefined, "caller_refill_test");
  await waitForExit(refillManager, refilledProcess.process_id);
} catch (error) {
  refillError = error;
}
assert.equal(refillError, undefined, "one launch token must refill after the configured refill interval");

const duplicateManager = new ProcessManager();
let first;
let duplicate;
try {
  first = duplicateManager.start("Start-Sleep -Seconds 5", undefined, "caller_duplicate_test");
  duplicate = duplicateManager.start("Start-Sleep -Seconds 5", undefined, "caller_duplicate_test");
  assert.equal(duplicate.process_id, first.process_id, "an identical live command must reuse its existing process");
} finally {
  const processIds = new Set([first?.process_id, duplicate?.process_id].filter(Boolean));
  for (const processId of processIds) await duplicateManager.kill(processId).catch(() => undefined);
}

const concurrencyManager = new ProcessManager();
const liveProcesses = [];
let concurrencyRejection;
let otherCallerProcess;
try {
  for (let index = 1; index <= 4; index += 1) {
    try {
      liveProcesses.push(concurrencyManager.start(`Start-Sleep -Seconds 5 # ${index}`, undefined, "caller_concurrency_test"));
    } catch (error) {
      concurrencyRejection = error;
      break;
    }
  }
  assert.ok(concurrencyRejection instanceof Error, "a fourth simultaneous process from one caller must be rejected");
  assert.match(concurrencyRejection.message, /start_process_concurrency_limited/);
  otherCallerProcess = concurrencyManager.start("Start-Sleep -Seconds 5 # other caller", undefined, "caller_concurrency_test_other");
  assert.equal(otherCallerProcess.running, true, "one caller's live-process cap must not block another caller");
} finally {
  if (otherCallerProcess) liveProcesses.push(otherCallerProcess);
  for (const process of liveProcesses) await concurrencyManager.kill(process.process_id).catch(() => undefined);
}

const receiptDirectory = mkdtempSync(join(tmpdir(), "shell-mcp-process-receipts-"));
try {
  const beforeRestart = new ProcessManager({ receiptDirectory });
  const started = beforeRestart.start("Write-Output 'RESTART_RECEIPT_OK'", undefined, "caller_restart_receipt_test");
  const completed = await waitForExit(beforeRestart, started.process_id);
  assert.equal(completed.exit_code, 0);

  const afterRestart = new ProcessManager({ receiptDirectory });
  const recovered = afterRestart.read(started.process_id);
  assert.equal(recovered.process_id, started.process_id);
  assert.equal(recovered.mcp_status, "OK");
  assert.equal(recovered.process_state, "COMPLETED");
  assert.equal(recovered.next_action, "STOP_READING");
  assert.ok(Number.isInteger(recovered.elapsed_ms) && recovered.elapsed_ms >= 0);
  assert.equal(recovered.running, false);
  assert.equal(recovered.exit_code, 0);
  assert.match(recovered.stdout, /RESTART_RECEIPT_OK/);
} finally {
  rmSync(receiptDirectory, { recursive: true, force: true });
}

const waitingManager = new ProcessManager();
let waitingProcess;
try {
  waitingProcess = waitingManager.start("Start-Sleep -Milliseconds 250; Write-Output 'WAITED_OUTPUT'", undefined, "caller_wait_test");
  const startedWaitingAt = Date.now();
  const waited = await waitingManager.readWithWait(waitingProcess.process_id, 6_000, 2_000);
  const elapsedWaitingMs = Date.now() - startedWaitingAt;
  assert.match(waited.stdout, /WAITED_OUTPUT/);
  assert.ok(elapsedWaitingMs >= 100, `readWithWait returned before output was available (${elapsedWaitingMs}ms)`);
  assert.ok(elapsedWaitingMs < 2_000, `readWithWait ignored process output (${elapsedWaitingMs}ms)`);
} finally {
  if (waitingProcess) await waitingManager.kill(waitingProcess.process_id).catch(() => undefined);
}

console.log("PASS process guard enforces rate, duplicate, live-concurrency, restart-receipt, and bounded-wait behavior");
