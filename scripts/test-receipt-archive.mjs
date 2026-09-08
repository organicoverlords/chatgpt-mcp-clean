import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "../dist/lib/process-manager.js";
import { setTelemetrySink, withTelemetryContext } from "../dist/lib/transport-telemetry.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForExit(manager, processId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = manager.read(processId);
    if (!state.running) return state;
    await sleep(10);
  }
  throw new Error(`process ${processId} did not exit during the archive test`);
}

const receiptDirectory = mkdtempSync(join(tmpdir(), "mcp-durable-receipt-"));
const telemetry = [];
setTelemetrySink((event) => telemetry.push(event));
try {
  const manager = new ProcessManager({ receiptDirectory });
  const started = withTelemetryContext(
    { request_id: "request_receipt_archive_test", caller_id: "caller_receipt_archive_test" },
    () => manager.start("Write-Output 'DURABLE_RECEIPT_OK'", undefined, "caller_receipt_archive_test"),
  );
  const completed = await waitForExit(manager, started.process_id);
  assert.equal(completed.exit_code, 0);
  assert.equal(completed.request_id, "request_receipt_archive_test");
  assert.equal(completed.audit_schema, "process-output-evidence.v1");
  assert.equal(completed.evidence_completeness, "complete");
  assert.equal(completed.execution_outcome, "success");
  assert.equal(completed.retained_output_chars, completed.retained_stdout_chars + completed.retained_stderr_chars);
  assert.equal(completed.retained_output_bytes, completed.retained_stdout_bytes + completed.retained_stderr_bytes);

  const archiveDay = completed.finished_at.slice(0, 10);
  const archivedPath = join(receiptDirectory, "archive", archiveDay, `${started.process_id}.json`);
  const archiveDeadline = Date.now() + 5_000;
  while (!existsSync(archivedPath) && Date.now() < archiveDeadline) await sleep(10);
  assert.equal(existsSync(archivedPath), true, "caller-visible completion must be followed by durable archival");
  const archived = JSON.parse(readFileSync(archivedPath, "utf8"));
  assert.equal(archived.request_id, "request_receipt_archive_test", "durable receipt must join back to its originating MCP request");
  assert.equal(archived.retained_stdout_chars, archived.stdout.length);
  assert.equal(archived.retained_stderr_chars, archived.stderr.length);
  assert.equal(archived.retained_output_chars, archived.stdout.length + archived.stderr.length);
  assert.equal(archived.stdout_sha256, createHash("sha256").update(archived.stdout, "utf8").digest("hex"));
  assert.equal(archived.stderr_sha256, createHash("sha256").update(archived.stderr, "utf8").digest("hex"));
  assert.equal(archived.evidence_completeness, "complete");
  const persisted = telemetry.find((event) => event.event === "process_receipt_persisted" && event.process_id === started.process_id);
  assert.ok(persisted, "receipt persistence telemetry must exist");
  assert.equal(persisted.request_id, "request_receipt_archive_test");
  assert.equal(persisted.retained_output_chars, archived.retained_output_chars);
  assert.equal(persisted.stdout_sha256, archived.stdout_sha256);
  assert.equal(persisted.evidence_completeness, "complete");
  assert.equal(persisted.execution_outcome, "success");

  const boundedStarted = withTelemetryContext(
    { request_id: "request_receipt_bounded_test", caller_id: "caller_receipt_archive_test" },
    () => manager.start("[Console]::Out.Write('X' * 100500)", undefined, "caller_receipt_archive_test"),
  );
  const bounded = await waitForExit(manager, boundedStarted.process_id);
  assert.equal(bounded.exit_code, 0);
  assert.equal(bounded.request_id, "request_receipt_bounded_test");
  assert.equal(bounded.evidence_completeness, "bounded", "truncated capture must never be presented as complete evidence");
  assert.equal(bounded.retained_stdout_chars, 100000);
  assert.equal(bounded.stdout_truncated, true);

  // Simulate an upgrade from the legacy flat-only layout, then age the hot receipt past
  // its 30-minute handoff window. Constructor pruning must migrate before deleting.
  rmSync(join(receiptDirectory, "archive"), { recursive: true, force: true });
  const hotReceiptPath = join(receiptDirectory, `${started.process_id}.json`);
  const expiredHotReceiptTime = new Date(Date.now() - 31 * 60 * 1000);
  utimesSync(hotReceiptPath, expiredHotReceiptTime, expiredHotReceiptTime);

  const afterHotExpiry = new ProcessManager({ receiptDirectory });
  assert.equal(existsSync(hotReceiptPath), false, "expired hot receipt should leave the flat directory only after archival");
  assert.equal(existsSync(archivedPath), true, "legacy flat receipt must be migrated to the durable archive");
  const recovered = afterHotExpiry.read(started.process_id);
  assert.equal(recovered.exit_code, 0);
  assert.match(recovered.stdout, /DURABLE_RECEIPT_OK/, "receipt must remain readable after the 30-minute hot-cache window");

  const legacyProcessId = "11111111-1111-4111-8111-111111111111";
  const legacyStartedAt = new Date(Date.now() - 2_000).toISOString();
  const legacyFinishedAt = new Date(Date.now() - 1_000).toISOString();
  writeFileSync(join(receiptDirectory, `${legacyProcessId}.json`), JSON.stringify({
    version: 1,
    process_id: legacyProcessId,
    pid: 1234,
    caller_id: "caller_legacy_receipt_test",
    command: "Write-Output 'LEGACY_RECEIPT_OK'",
    cwd: receiptDirectory,
    stdout: "LEGACY_RECEIPT_OK\n",
    stderr: "",
    exit_code: 0,
    signal: null,
    started_at: legacyStartedAt,
    finished_at: legacyFinishedAt,
  }), "utf8");
  const legacyRecovered = afterHotExpiry.read(legacyProcessId);
  assert.match(legacyRecovered.stdout, /LEGACY_RECEIPT_OK/, "pre-audit version-1 receipts must remain readable");
  assert.equal(legacyRecovered.audit_schema, "process-output-evidence.v1");
  assert.equal(legacyRecovered.evidence_completeness, "complete");
  assert.equal(legacyRecovered.execution_outcome, "success");
  assert.equal(legacyRecovered.request_id, undefined, "legacy receipts must not invent a request id");

  const staleArchiveDirectory = join(receiptDirectory, "archive", "2000-01-01");
  mkdirSync(staleArchiveDirectory, { recursive: true });
  writeFileSync(join(staleArchiveDirectory, "stale.json"), "{}", "utf8");
  new ProcessManager({ receiptDirectory });
  assert.equal(existsSync(staleArchiveDirectory), false, "stale day shards must be pruned by durable retention");
} finally {
  setTelemetrySink(undefined);
  rmSync(receiptDirectory, { recursive: true, force: true });
}

console.log("PASS durable process receipts survive the hot-cache window and stale day shards are pruned");
