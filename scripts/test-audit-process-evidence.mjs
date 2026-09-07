import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(path.join(os.tmpdir(), "mcp-audit-evidence-"));
const archive = path.join(root, "archive", "2026-09-05");
mkdirSync(archive, { recursive: true });
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const receipt = (overrides = {}) => ({
  version: 1,
  process_id: "p-default",
  caller_id: "caller_a",
  request_id: "request-default",
  audit_schema: "process-output-evidence.v1",
  stdout: "abc",
  stderr: "",
  retained_stdout_bytes: 3,
  retained_stderr_bytes: 0,
  retained_output_bytes: 3,
  stdout_sha256: sha("abc"),
  stderr_sha256: sha(""),
  evidence_completeness: "complete",
  execution_outcome: "success",
  exit_code: 0,
  started_at: "2026-09-05T20:00:00.000Z",
  finished_at: "2026-09-05T20:00:01.000Z",
  ...overrides,
});

try {
  const p1Id = "11111111-1111-4111-8111-111111111111";
  const p1 = receipt({ process_id: p1Id, request_id: "r1" });
  writeFileSync(path.join(root, `${p1Id}.json`), JSON.stringify(p1));
  writeFileSync(path.join(archive, `${p1Id}.json`), JSON.stringify(p1)); // duplicate must be skipped before JSON parsing

  const p2 = receipt({
    process_id: "p2",
    audit_schema: undefined,
    request_id: null,
    stdout: "SECRET-BOUNDED",
    stderr: "err",
    retained_stdout_bytes: 14,
    retained_stderr_bytes: 3,
    retained_output_bytes: 17,
    stdout_sha256: sha("SECRET-BOUNDED"),
    stderr_sha256: sha("err"),
    evidence_completeness: "bounded",
    execution_outcome: "nonzero_exit",
    exit_code: 7,
    finished_at: "2026-09-05T20:02:00.000Z",
  });
  writeFileSync(path.join(root, "p2.json"), JSON.stringify(p2));

  const p3 = receipt({
    process_id: "p3",
    caller_id: "caller_b",
    request_id: "r3",
    stdout: "z",
    retained_stdout_bytes: 1,
    retained_output_bytes: 1,
    stdout_sha256: "0".repeat(64), // deliberate mismatch must be surfaced only as aggregate integrity state
    execution_outcome: "signaled",
    signal: "SIGTERM",
    exit_code: null,
    finished_at: "2026-09-05T20:03:00.000Z",
  });
  writeFileSync(path.join(root, "p3.json"), JSON.stringify(p3));

  const p4 = receipt({
    process_id: "p4",
    caller_id: "caller_c",
    request_id: null,
    stdout: "ok",
    retained_stdout_bytes: 2,
    retained_output_bytes: 2,
    stdout_sha256: undefined,
    stderr_sha256: undefined,
    finished_at: "2026-09-05T20:04:00.000Z",
  });
  writeFileSync(path.join(root, "p4.json"), JSON.stringify(p4));

  const old = receipt({ process_id: "old", finished_at: "2026-09-01T20:00:00.000Z" });
  writeFileSync(path.join(root, "old.json"), JSON.stringify(old));
  writeFileSync(path.join(root, "malformed.json"), "{");
  writeFileSync(path.join(root, "other.json"), JSON.stringify({ hello: "world" }));

  const output = execFileSync(process.execPath, [
    fileURLToPath(new URL("./audit-process-evidence.mjs", import.meta.url)),
    "--receipt-dir", root,
    "--since", "2026-09-05T00:00:00.000Z",
  ], { encoding: "utf8" });
  assert.ok(!output.includes("SECRET-BOUNDED"), "raw stdout must never be emitted");
  const report = JSON.parse(output);
  assert.equal(report.schema, "process-evidence-audit-summary.v1");
  assert.equal(report.semantics.aggregate_only, true);
  assert.equal(report.semantics.semantic_work_quality_scored, false);
  assert.equal(report.semantics.caller_id_is_opaque_not_named_worker_identity, true);
  assert.equal(report.source.scanned_json_files, 8);
  assert.equal(report.source.parsed_json_files, 7);
  assert.equal(report.source.duplicate_durable_files_skipped, 1);
  assert.equal(report.source.deduplicated_process_receipts, 4);
  assert.equal(report.source.malformed_json_files, 1);
  assert.equal(report.source.non_receipt_json_files, 1);
  assert.equal(report.totals.process_count, 4);
  assert.equal(report.totals.total_retained_output_bytes, 23);
  assert.equal(report.totals.completeness.complete, 3);
  assert.equal(report.totals.completeness.bounded, 1);
  assert.equal(report.totals.outcomes.success, 2);
  assert.equal(report.totals.outcomes.nonzero_exit, 1);
  assert.equal(report.totals.outcomes.signaled, 1);
  assert.equal(report.totals.missing_request_id_count, 2);
  assert.equal(report.totals.audit_v1_receipt_count, 3);
  assert.equal(report.totals.non_audit_v1_receipt_count, 1);
  assert.equal(report.totals.audit_v1_missing_request_id_count, 1);
  assert.equal(report.totals.audit_v1_missing_integrity_metadata_count, 1);
  assert.equal(report.totals.audit_v1_coverage_pct, 75);
  assert.equal(report.totals.request_id_coverage_pct, 50);
  assert.equal(report.totals.integrity_metadata_coverage_pct, 75);
  assert.equal(report.totals.audit_v1_request_id_coverage_pct, 66.67);
  assert.equal(report.totals.audit_v1_integrity_metadata_coverage_pct, 66.67);
  assert.equal(report.totals.first_finished_at, "2026-09-05T20:00:01.000Z");
  assert.equal(report.totals.last_finished_at, "2026-09-05T20:04:00.000Z");
  assert.equal(report.totals.hash_verification.verified, 2);
  assert.equal(report.totals.hash_verification.mismatch, 1);
  assert.equal(report.totals.hash_verification.unavailable, 1);
  const callerA = report.callers.find((row) => row.caller_id === "caller_a");
  assert.equal(callerA.process_count, 2);
  assert.equal(callerA.total_retained_output_bytes, 20);
  assert.equal(callerA.average_retained_output_bytes, 10);
  assert.equal(callerA.completeness.bounded, 1);
  assert.equal(callerA.outcomes.nonzero_exit, 1);
  const callerB = report.callers.find((row) => row.caller_id === "caller_b");
  assert.equal(callerB.process_count, 1);
  assert.equal(callerB.hash_verification.mismatch, 1);
  const callerC = report.callers.find((row) => row.caller_id === "caller_c");
  assert.equal(callerC.process_count, 1);
  assert.equal(callerC.audit_v1_missing_request_id_count, 1);
  assert.equal(callerC.audit_v1_missing_integrity_metadata_count, 1);
  console.log("PASS audit_process_evidence aggregate_only=true deduplicated=true raw_output=false hashes_verified=true semantic_quality_not_scored=true");
} finally {
  rmSync(root, { recursive: true, force: true });
}
