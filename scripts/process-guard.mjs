import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  for (let index = 1; index <= 5; index += 1) {
    try {
      liveProcesses.push(concurrencyManager.start(`Start-Sleep -Seconds 5 # ${index}`, undefined, "caller_concurrency_test"));
    } catch (error) {
      concurrencyRejection = error;
      break;
    }
  }
  assert.ok(concurrencyRejection instanceof Error, "a fifth simultaneous process from one caller must be rejected");
  assert.match(concurrencyRejection.message, /start_process_concurrency_limited/);
  otherCallerProcess = concurrencyManager.start("Start-Sleep -Seconds 5 # other caller", undefined, "caller_concurrency_test_other");
  assert.equal(otherCallerProcess.running, true, "one caller's live-process cap must not block another caller");
} finally {
  if (otherCallerProcess) liveProcesses.push(otherCallerProcess);
  for (const process of liveProcesses) await concurrencyManager.kill(process.process_id).catch(() => undefined);
}

assert.throws(() => new ProcessManager({ maxLiveTotal: 0 }), /maxLiveTotal must be an integer between 1 and 80/);
assert.doesNotThrow(() => new ProcessManager({ maxLiveTotal: 80 }), "explicit 80-process shared-host ceiling must be supported");
assert.throws(() => new ProcessManager({ maxLiveTotal: 81 }), /maxLiveTotal must be an integer between 1 and 80/);

const uncappedDefaultDirectory = mkdtempSync(join(tmpdir(), "mcp-uncapped-default-"));
try {
  new ProcessManager({ receiptDirectory: uncappedDefaultDirectory });
  assert.equal(existsSync(join(uncappedDefaultDirectory, ".host-admission")), false, "default ProcessManager must not create shared-host admission slots");
} finally {
  rmSync(uncappedDefaultDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
const hostAdmissionDirectory = mkdtempSync(join(tmpdir(), "mcp-host-admission-"));
const hostAdmissionProcesses = [];
try {
  const firstManager = new ProcessManager({ receiptDirectory: hostAdmissionDirectory, maxLiveTotal: 2 });
  const secondManager = new ProcessManager({ receiptDirectory: hostAdmissionDirectory, maxLiveTotal: 2 });
  hostAdmissionProcesses.push(firstManager.start("Start-Sleep -Seconds 10 # host slot one", undefined, "caller_host_slot_one"));
  hostAdmissionProcesses.push(secondManager.start("Start-Sleep -Seconds 10 # host slot two", undefined, "caller_host_slot_two"));
  assert.throws(
    () => firstManager.start("Start-Sleep -Seconds 10 # host slot blocked", undefined, "caller_host_slot_three"),
    /start_process_host_concurrency_limited/,
    "distinct callers and ProcessManager instances sharing one receipt root must not bypass the host cap",
  );
  await firstManager.kill(firstHostProcess.process_id);
  const replacement = secondManager.start("Start-Sleep -Seconds 10 # host slot replacement", undefined, "caller_host_slot_three");
  hostAdmissionProcesses.push({ manager: secondManager, process: replacement });
  assert.equal(replacement.running, true, "host admission capacity must return after an owned process exits");
} finally {
  for (const item of hostAdmissionProcesses) {
    await item.manager.kill(item.process.process_id).catch(() => undefined);
  }
  rmSync(hostAdmissionDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const drainStatusManager = new ProcessManager();
let drainStatusProcess;
try {
  assert.equal(drainStatusManager.liveProcessCount(), 0, "fresh process manager must report no live processes");
  drainStatusProcess = drainStatusManager.start("Start-Sleep -Seconds 10", undefined, "caller_drain_status_test");
  assert.equal(drainStatusManager.liveProcessCount(), 1, "live process count must expose a replacement drain blocker");
  await drainStatusManager.kill(drainStatusProcess.process_id);
  assert.equal(drainStatusManager.liveProcessCount(), 0, "live process count must clear after the managed process exits");
} finally {
  if (drainStatusProcess) await drainStatusManager.kill(drainStatusProcess.process_id).catch(() => undefined);
}

const protectedControlManager = new ProcessManager();
const protectedControlDirectory = mkdtempSync(join(tmpdir(), "mcp-protected-control-plane-"));
try {
  const fakeCommanderLauncher = join(protectedControlDirectory, "Start-DesktopCommanderFallbackHidden.ps1");
  writeFileSync(fakeCommanderLauncher, "Start-Sleep -Milliseconds 750\nWrite-Output 'PROTECTED_CONTROL_PROCESS_EXITED'\n");
  const protectedProcess = protectedControlManager.start(`& '${fakeCommanderLauncher}'`, undefined, "caller_protected_control_test");
  await assert.rejects(
    protectedControlManager.kill(protectedProcess.process_id),
    /protected MCP\/Commander control-plane termination is blocked/,
    "kill_process must fail closed for a managed control-plane launch command",
  );
  const protectedExit = await waitForExit(protectedControlManager, protectedProcess.process_id);
  assert.equal(protectedExit.running, false, JSON.stringify(protectedExit));
  assert.match(protectedExit.stdout, /PROTECTED_CONTROL_PROCESS_EXITED/);
} finally {
  rmSync(protectedControlDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const protectedCrossCloneDirectory = mkdtempSync(join(tmpdir(), "mcp-protected-cross-clone-"));
try {
  const fakeCommanderLauncher = join(protectedCrossCloneDirectory, "Start-DesktopCommanderFallbackHidden.ps1");
  writeFileSync(fakeCommanderLauncher, "Start-Sleep -Milliseconds 900\nWrite-Output 'PROTECTED_CROSS_CLONE_EXITED'\n");
  const ownerManager = new ProcessManager({ receiptDirectory: protectedCrossCloneDirectory });
  const backupManager = new ProcessManager({ receiptDirectory: protectedCrossCloneDirectory });
  const protectedProcess = ownerManager.start(`& '${fakeCommanderLauncher}'`, undefined, "caller_protected_cross_clone_owner");
  await assert.rejects(
    backupManager.kill(protectedProcess.process_id),
    /protected MCP\/Commander control-plane termination is blocked/,
    "cross-clone kill must preserve the owner-side protected-control-plane refusal",
  );
  const protectedExit = await waitForExit(ownerManager, protectedProcess.process_id);
  assert.equal(protectedExit.running, false, JSON.stringify(protectedExit));
  assert.match(protectedExit.stdout, /PROTECTED_CROSS_CLONE_EXITED/);
} finally {
  rmSync(protectedCrossCloneDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
const receiptDirectory = mkdtempSync(join(tmpdir(), "shell-mcp-process-receipts-"));
try {
  const beforeRestart = new ProcessManager({ receiptDirectory });
  const started = beforeRestart.start("Write-Output 'RESTART_RECEIPT_OK'", undefined, "caller_restart_receipt_test");
  const completed = await waitForExit(beforeRestart, started.process_id);
  assert.equal(completed.exit_code, 0);

  const hotReceiptPath = join(receiptDirectory, `${started.process_id}.json`);
  const receiptDeadline = Date.now() + 5_000;
  while (!existsSync(hotReceiptPath) && Date.now() < receiptDeadline) await sleep(10);
  assert.equal(existsSync(hotReceiptPath), true, "caller-visible completion must be followed by a durable hot receipt");

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

const sharedControlDirectory = mkdtempSync(join(tmpdir(), "shell-mcp-cross-clone-control-"));
try {
  const ownerManager = new ProcessManager({ receiptDirectory: sharedControlDirectory });
  const backupManager = new ProcessManager({ receiptDirectory: sharedControlDirectory });
  const started = ownerManager.start(
    "Start-Sleep -Milliseconds 300; Write-Output 'CROSS_CLONE_LIVE_OK'; Start-Sleep -Seconds 10",
    undefined,
    "caller_cross_clone_owner",
  );
  const crossCloneReadStartedAt = Date.now();
  const immediateFromBackup = await backupManager.readWithWait(started.process_id, 6_000, 0);
  const crossCloneReadDurationMs = Date.now() - crossCloneReadStartedAt;
  assert.ok(crossCloneReadDurationMs < 750, `cross-clone wait_ms=0 blocked (${crossCloneReadDurationMs}ms)`);
  assert.equal(immediateFromBackup.running, true);
  const liveFromBackup = await backupManager.readWithWait(started.process_id, 6_000, 1_500);
  assert.equal(liveFromBackup.running, true);
  assert.match(liveFromBackup.stdout, /CROSS_CLONE_LIVE_OK/);
  const killedFromBackup = await backupManager.kill(started.process_id);
  assert.equal(killedFromBackup.killed, true, JSON.stringify(killedFromBackup));
  const ownerAfterKill = await waitForExit(ownerManager, started.process_id);
  assert.equal(ownerAfterKill.running, false);
  const completedFromBackup = backupManager.read(started.process_id);
  assert.equal(completedFromBackup.running, false);
  assert.match(completedFromBackup.stdout, /CROSS_CLONE_LIVE_OK/);
} finally {
  rmSync(sharedControlDirectory, { recursive: true, force: true });
}

const nonBlockingManager = new ProcessManager();
let nonBlockingProcess;
try {
  nonBlockingProcess = nonBlockingManager.start("Start-Sleep -Milliseconds 1500; Write-Output 'LATE_OUTPUT'", undefined, "caller_wait0_test");
  const startedReadAt = Date.now();
  const immediate = await nonBlockingManager.readWithWait(nonBlockingProcess.process_id, 6_000, 0);
  const readDurationMs = Date.now() - startedReadAt;
  assert.ok(readDurationMs < 500, `readWithWait(wait_ms=0) blocked (${readDurationMs}ms)`);
  assert.equal(immediate.running, true, "wait_ms=0 should observe the still-running process rather than await completion");
  assert.ok(immediate.elapsed_ms >= 0, "elapsed_ms remains process age, not read-call latency");
} finally {
  if (nonBlockingProcess) await nonBlockingManager.kill(nonBlockingProcess.process_id).catch(() => undefined);
}

const fastPathManager = new ProcessManager();
const fastPathStartedAt = Date.now();
const fastPathInitial = await fastPathManager.startWithWait("Write-Output 'FAST_PATH_OK'", undefined, "caller_fast_path_test", 2_000);
const fastPathInitialDurationMs = Date.now() - fastPathStartedAt;
assert.ok(fastPathInitialDurationMs < 3_000, `startWithWait exceeded its bounded launch window (${fastPathInitialDurationMs}ms)`);
const fastPath = fastPathInitial.running ? await waitForExit(fastPathManager, fastPathInitial.process_id) : fastPathInitial;
assert.equal(fastPath.running, false, JSON.stringify(fastPath));
assert.equal(fastPath.next_action, "STOP_READING");
assert.match(fastPath.stdout, /FAST_PATH_OK/);
const fastPathReplay = await fastPathManager.readWithWait(fastPath.process_id, 6_000, 0);
assert.match(fastPathReplay.stdout, /FAST_PATH_OK/, "start_process output must remain readable until read_output consumes it");

const boundedStartManager = new ProcessManager();
let boundedStart;
try {
  const boundedStartedAt = Date.now();
  boundedStart = await boundedStartManager.startWithWait("Start-Sleep -Seconds 5; Write-Output 'TOO_LATE'", undefined, "caller_bounded_start_test", 150);
  const boundedDurationMs = Date.now() - boundedStartedAt;
  assert.equal(boundedStart.running, true, JSON.stringify(boundedStart));
  assert.equal(boundedStart.next_action, "READ_SAME_PROCESS_ID");
  assert.ok(boundedDurationMs >= 100, `startWithWait returned before its bounded wait (${boundedDurationMs}ms)`);
  assert.ok(boundedDurationMs < 1_000, `startWithWait blocked too long (${boundedDurationMs}ms)`);
} finally {
  if (boundedStart) await boundedStartManager.kill(boundedStart.process_id).catch(() => undefined);
}

const compactWaitManager = new ProcessManager();
let compactWaitProcess;
try {
  compactWaitProcess = compactWaitManager.start("Write-Output 'FIRST_PACKET'; Start-Sleep -Seconds 5", undefined, "caller_compact_wait_test");
  const firstPacket = await compactWaitManager.readWithWait(compactWaitProcess.process_id, 6_000, 2_000);
  assert.match(firstPacket.stdout, /FIRST_PACKET/);
  await new Promise((resolve) => setTimeout(resolve, 250));
  compactWaitManager.read(compactWaitProcess.process_id, 6_000);
  const noChange = await compactWaitManager.readWithWait(compactWaitProcess.process_id, 6_000, 150);
  assert.equal(noChange.running, true, JSON.stringify(noChange));
  assert.equal(noChange.no_change, true, JSON.stringify(noChange));
  assert.equal(noChange.stdout, "");
  assert.equal(noChange.stderr, "");
} finally {
  if (compactWaitProcess) await compactWaitManager.kill(compactWaitProcess.process_id).catch(() => undefined);
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


const inheritedHandleDirectory = mkdtempSync(join(tmpdir(), "mcp-inherited-handle-"));
try {
  const helper = join(inheritedHandleDirectory, "hold-stdio.cjs");
  writeFileSync(helper, `const { spawn } = require("node:child_process");\nconst child = spawn(process.execPath, ["-e", "setTimeout(()=>{},2500)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });\nchild.unref();\nconsole.log("OWNER_PID_EXITING");\n`);
  const manager = new ProcessManager();
  const queued = manager.start(`& node.exe '${helper}'`, undefined, "caller_inherited_handle_test");
  let exited = queued;
  let ownerPidObservedAt = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && exited.running) {
    exited = await manager.readWithWait(queued.process_id, 6_000, 250);
    if (ownerPidObservedAt === null && Number(exited.pid) > 0) ownerPidObservedAt = Date.now();
  }
  assert.equal(exited.running, false, JSON.stringify(exited));
  assert.match(exited.stdout, /OWNER_PID_EXITING/);
  assert.ok(ownerPidObservedAt !== null, JSON.stringify(exited));
  assert.ok(Date.now() - ownerPidObservedAt < 2_000, "owned PID exit must not wait for descendant-inherited stdio handles");
  const killAfterExit = await manager.kill(exited.process_id);
  assert.equal(killAfterExit.already_exited, true, JSON.stringify(killAfterExit));
} finally {
  rmSync(inheritedHandleDirectory, { recursive: true, force: true });
}

const receiptChurnDirectory = mkdtempSync(join(tmpdir(), "mcp-receipt-churn-"));
try {
  // Use a tiny injected in-memory cap so this proves disk-receipt fallback without
  // serially launching 80 PowerShell processes on every full-suite run.
  const receiptChurnManager = new ProcessManager({ receiptDirectory: receiptChurnDirectory, maxCompletedProcesses: 3 });
  let oldestReceiptProcessId;
  for (let index = 0; index < 5; index += 1) {
    const initial = await receiptChurnManager.startWithWait(`Write-Output 'RECEIPT_CHURN_${index}'`, undefined, `caller_receipt_churn_${index % 8}`, 2_000);
    const completed = initial.running ? await waitForExit(receiptChurnManager, initial.process_id) : initial;
    assert.equal(completed.running, false, JSON.stringify(completed));
    if (index === 0) oldestReceiptProcessId = completed.process_id;
  }
  const recoveryManager = new ProcessManager({ receiptDirectory: receiptChurnDirectory });
  const recoveredOldest = recoveryManager.read(oldestReceiptProcessId);
  assert.equal(recoveredOldest.running, false, JSON.stringify(recoveredOldest));
  assert.match(recoveredOldest.stdout, /RECEIPT_CHURN_0/, "receipt churn from other callers must not evict a process before the retention window expires");
} finally {
  rmSync(receiptChurnDirectory, { recursive: true, force: true });
}
const eightySlotDirectory = mkdtempSync(join(tmpdir(), "mcp-host-admission-80-"));
let eightySlotProcess;
try {
  const slots = join(eightySlotDirectory, ".host-admission");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(slots, { recursive: true });
  for (let index = 0; index < 79; index += 1) {
    writeFileSync(join(slots, `${index}.json`), JSON.stringify({ version: 1, process_id: `occupied-${index}`, manager_pid: process.pid, child_pid: null, claimed_at: new Date().toISOString() }));
  }
  const eightySlotManager = new ProcessManager({ receiptDirectory: eightySlotDirectory, maxLiveTotal: 80 });
  eightySlotProcess = eightySlotManager.start("Start-Sleep -Seconds 10 # slot eighty", undefined, "caller_slot_eighty");
  assert.equal(eightySlotProcess.running, true, "slot 80 must be admitted");
  assert.throws(
    () => eightySlotManager.start("Start-Sleep -Seconds 10 # slot eighty one blocked", undefined, "caller_slot_eighty_one"),
    /start_process_host_concurrency_limited: shared MCP host already has 80 live process slots; max=80/,
    "slot 81 must be rejected without requiring 80 real child processes",
  );
  await eightySlotManager.kill(eightySlotProcess.process_id);
  eightySlotProcess = undefined;
} finally {
  rmSync(eightySlotDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log("PASS process guard enforces duplicate reuse, per-caller live concurrency, uncapped shared-host defaults with optional explicit host caps, protected control-plane kill refusal, restart receipts, cross-clone control, fast-start collapse, compact no-change waits, nonblocking zero-wait, and bounded-wait behavior, and time-based receipt retention");
