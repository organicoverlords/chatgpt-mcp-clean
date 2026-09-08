import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ProcessManager } from "../dist/lib/process-manager.js";

const source = readFileSync(new URL("../src/lib/process-manager.ts", import.meta.url), "utf8");
assert.match(source, /setInterval\(\(\) => \{ void this\.sweepControlRequestsAsync\(\); \}, CONTROL_POLL_MS\)/);
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
