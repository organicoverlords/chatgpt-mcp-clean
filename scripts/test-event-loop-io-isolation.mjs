import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/lib/process-manager.ts", import.meta.url), "utf8");
assert.match(source, /setInterval\(\(\) => \{ void this\.sweepControlRequestsAsync\(\); \}, CONTROL_POLL_MS\)/);
assert.match(source, /const cwd = await boundedValidatedCwd\(workingDirectory\)/);
assert.match(source, /await this\.writeControlFileAsync\(requestPath, request\)/);
assert.match(source, /await this\.readReceiptAsync\(processId, maxChars\)/);
assert.match(source, /await this\.readReceiptAsync\(processId, MAX_READ_CHARS\)/);
assert.match(source, /await this\.persistReceiptAsync\(state, exitCode, signal, finishedAt\)/);
assert.doesNotMatch(source, /setInterval\(\(\) => this\.sweepControlRequests\(\)/);
assert.doesNotMatch(source, /const started = this\.start\(command, workingDirectory, callerId\)/);
assert.doesNotMatch(source, /this\.persistReceipt\(state\)/);
console.log("PASS event-loop I/O isolation guard");