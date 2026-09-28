import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessManager } from "../dist/lib/process-manager.js";
import { setTelemetrySink, withTelemetryContext } from "../dist/lib/transport-telemetry.js";

const root = mkdtempSync(join(tmpdir(), "mcp-capacity-receipts-"));
const events = [];
setTelemetrySink((event) => events.push(event));
const manager = new ProcessManager({ receiptDirectory: root, maxLivePerCaller: 2, maxLiveTotal: 3 });
const jobs = [];

function start(caller, suffix) {
  const job = manager.startStructured(process.execPath, ["-e", "setInterval(() => {}, 1000)", suffix], undefined, caller);
  jobs.push(job.process_id);
  return job;
}

function rejection(action, code, scope, live, limit) {
  let error;
  withTelemetryContext({ request_id: `request-${scope}`, session_id: `session-${scope}` }, () => {
    try { action(); } catch (caught) { error = caught; }
  });
  assert.match(error?.message ?? "", new RegExp(code));
  const id = error.message.match(/rejection_id=([0-9a-f-]+)/)?.[1];
  assert.ok(id, `${scope} rejection must return a receipt ID`);
  const receipt = JSON.parse(readFileSync(join(root, "archive", new Date().toISOString().slice(0, 10), `rejected-${id}.json`), "utf8"));
  assert.equal(receipt.kind, "process_concurrency_rejection");
  assert.equal(receipt.scope, scope);
  assert.equal(receipt.live_process_count, live);
  assert.equal(receipt.max_live_processes, limit);
  assert.equal(receipt.request_id, `request-${scope}`);
  assert.equal(receipt.session_id, `session-${scope}`);
  assert.ok(events.some((event) => event.rejection_id === id && event.request_id === `request-${scope}`));
  return receipt;
}

try {
  const first = start("caller-a", "first");
  const second = start("caller-a", "second");
  const callerReceipt = rejection(() => start("caller-a", "third"), "start_process_concurrency_limited", "caller", 2, 2);
  assert.deepEqual(callerReceipt.active_process_ids, [first.process_id, second.process_id]);

  start("caller-b", "third");
  rejection(() => start("caller-c", "fourth"), "start_process_host_concurrency_limited", "host", 3, 3);
  const audit = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("./audit-process-evidence.mjs", import.meta.url)), "--receipt-dir", root, "--since-minutes", "30"], { encoding: "utf8" }));
  assert.deepEqual(audit.rejections, { total: 2, caller_limit: 1, host_limit: 1 });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const id of jobs) {
    const result = await manager.kill(id).catch(() => undefined);
    if (!result || result.running === true) process.exitCode = 1;
  }
  setTelemetrySink(undefined);
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
if (!process.exitCode) console.log("PASS concurrency_rejection_receipt caller=2 host=3 durable=true");
process.exit(process.exitCode ?? 0); // ProcessManager's shared launcher worker outlives this one-shot test.
