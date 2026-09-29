import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "../dist/lib/process-manager.js";
import { withTelemetryContext } from "../dist/lib/transport-telemetry.js";

const receiptDirectory = await mkdtemp(join(tmpdir(), "mcp-cross-owner-cancel-"));
const owner = new ProcessManager({ receiptDirectory });
const requester = new ProcessManager({ receiptDirectory });
let processId;
try {
  processId = owner.startStructured(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, "cross-owner-test").process_id;
  await new Promise((resolve) => setTimeout(resolve, 300));
  withTelemetryContext({ caller_id: "cross-owner-reader" }, () => owner.read(processId));

  const abort = new AbortController();
  const pending = withTelemetryContext({ caller_id: "cross-owner-reader" }, () =>
    requester.readWithWait(processId, 4096, 10_000, abort.signal));
  const deadline = Date.now() + 3_000;
  while (owner.controlRequestsInFlight.size === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(owner.controlRequestsInFlight.size, 1, "owner must take the cross-process read");
  const abortAt = Date.now();
  abort.abort(new Error("requester disconnected"));
  await assert.rejects(pending, /requester disconnected/);
  assert.ok(Date.now() - abortAt < 500, "requester must stop waiting promptly");
  const ownerDeadline = Date.now() + 1_000;
  while (owner.controlRequestsInFlight.size > 0 && Date.now() < ownerDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(owner.controlRequestsInFlight.size, 0, "owner must release its waiter after requester disconnects");
  assert.equal(owner.read(processId).running, true, "disconnect must leave child running");
  console.log("PASS cross-owner read cancellation releases both waiters and preserves the child process");
} finally {
  if (processId) await owner.kill(processId).catch(() => undefined);
  await rm(receiptDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(0);
