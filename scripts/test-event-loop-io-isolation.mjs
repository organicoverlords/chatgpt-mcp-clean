import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { ProcessManager } from "../dist/lib/process-manager.js";

const source = readFileSync(new URL("../src/lib/process-manager.ts", import.meta.url), "utf8");
assert.match(source, /watch\(this\.controlRequestDirectory, \(\) => this\.scheduleControlRequestSweep\(\)\)/);
assert.match(source, /setImmediate\(\(\) => \{\s*this\.controlSweepScheduled = false;\s*void this\.sweepControlRequestsAsync\(\);/);
assert.doesNotMatch(source, /setInterval\(\(\) => \{ void this\.sweepControlRequestsAsync\(\); \}, CONTROL_POLL_MS\)/);
assert.match(source, /const cwd = await boundedValidatedCwd\(workingDirectory\)/);
assert.match(source, /await this\.writeControlFileAsync\(requestPath, request\)/);
assert.match(source, /await this\.readReceiptAsync\(processId, maxChars\)/);
assert.match(source, /await this\.readReceiptAsync\(processId, MAX_READ_CHARS\)/);
assert.match(source, /state\.resolveDone\(\);\s*void this\.persistReceiptAsync\(state, exitCode, signal, finishedAt\)/);
assert.doesNotMatch(source, /await this\.persistReceiptAsync\(state, exitCode, signal, finishedAt\)/);
assert.doesNotMatch(source, /setInterval\(\(\) => this\.sweepControlRequests\(\)/);
assert.doesNotMatch(source, /const started = this\.start\(command, workingDirectory, callerId\)/);
assert.doesNotMatch(source, /this\.persistReceipt\(state\)/);
const manager = new ProcessManager();
manager.persistReceiptAsync = async () => await new Promise(() => undefined);
const completionStartedAt = performance.now();
const completion = await manager.startWithWait(
  "Write-Output RECEIPT_IO_ISOLATION_OK",
  undefined,
  "caller_receipt_io_isolation",
  2_500,
);
const completionMs = performance.now() - completionStartedAt;
assert.equal(completion.running, false, JSON.stringify(completion));
assert.match(String(completion.stdout), /RECEIPT_IO_ISOLATION_OK/);
assert.ok(completionMs < 2_000, `process completion remained coupled to receipt persistence: ${completionMs.toFixed(1)}ms`);

console.log("PASS event-loop I/O isolation guard");

// A high-output child must not fan every pipe chunk across the Worker boundary.
// The launcher may batch worker messages, but it must spool every character losslessly.
// The parent keeps only a 256k diagnostic tail while read_output pages the complete spool.
const { Worker } = await import("node:worker_threads");
const { join, resolve } = await import("node:path");
const { tmpdir } = await import("node:os");
const outputWorker = new Worker(new URL("../dist/lib/process-launch-worker.js", import.meta.url), {
  workerData: { powershellExe: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
});
const floodRequestId = "output-backpressure-regression";
const outputSpoolRoot = mkdtempSync(join(tmpdir(), "mcp-worker-spool-"));
const stdoutSpoolPath = join(outputSpoolRoot, "stdout.utf16le");
const stderrSpoolPath = join(outputSpoolRoot, "stderr.utf16le");
let stdoutMessages = 0;
let retainedTail = "";
let lastTick = performance.now();
let maxTimerLagMs = 0;
const timerProbe = setInterval(() => {
  const now = performance.now();
  maxTimerLagMs = Math.max(maxTimerLagMs, now - lastTick - 10);
  lastTick = now;
}, 10);
const floodExit = await new Promise((resolveExit, rejectExit) => {
  const timeout = setTimeout(() => rejectExit(new Error("output backpressure worker timed out")), 20_000);
  outputWorker.once("error", rejectExit);
  outputWorker.on("message", (message) => {
    if (message?.requestId !== floodRequestId) return;
    if (message.type === "stdout") {
      stdoutMessages += 1;
      retainedTail = (retainedTail + String(message.data ?? "")).slice(-256_000);
    }
    if (message.type === "error") {
      clearTimeout(timeout);
      rejectExit(new Error(String(message.error ?? "worker error")));
    }
    if (message.type === "exit") {
      clearTimeout(timeout);
      resolveExit(message);
    }
  });
  outputWorker.postMessage({
    type: "launch",
    requestId: floodRequestId,
    cwd: resolve("."),
    command: "$x = 'X' * 33554432; [Console]::Out.Write($x); [Console]::Out.Write(('Y' * 100000))",
    stdoutSpoolPath,
    stderrSpoolPath,
  });
});
clearInterval(timerProbe);
await outputWorker.terminate();
assert.equal(floodExit.code, 0, JSON.stringify(floodExit));
assert.equal(retainedTail.length, 256_000, `retained tail length=${retainedTail.length}`);
assert.ok(retainedTail.endsWith("Y".repeat(100_000)), "worker batching changed the diagnostic tail suffix");
assert.equal(statSync(stdoutSpoolPath).size / 2, 33_654_432, "worker spool lost output characters");
assert.ok(stdoutMessages <= 140, `stdout fanout remained unbounded: ${stdoutMessages} worker messages`);
assert.ok(maxTimerLagMs < 500, `event loop starved ${maxTimerLagMs.toFixed(1)}ms during output flood`);
rmSync(outputSpoolRoot, { recursive: true, force: true });
console.log(`PASS output backpressure lossless_spool=true messages=${stdoutMessages} max_timer_lag_ms=${maxTimerLagMs.toFixed(1)}`);
