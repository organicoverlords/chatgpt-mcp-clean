#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { receiptDir: process.env.MCP_PROCESS_RECEIPT_DIR || null, since: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--receipt-dir") args.receiptDir = argv[++i] || null;
    else if (arg === "--since") args.since = argv[++i] || null;
    else if (arg === "--since-minutes") {
      const minutes = Number(argv[++i]);
      if (!Number.isFinite(minutes) || minutes < 0) throw new Error("--since-minutes must be a non-negative number");
      args.since = new Date(Date.now() - minutes * 60_000).toISOString();
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/audit-process-evidence.mjs --receipt-dir <dir> [--since <ISO> | --since-minutes <n>]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.receiptDir) throw new Error("receipt directory is required via --receipt-dir or MCP_PROCESS_RECEIPT_DIR");
  if (args.since && Number.isNaN(Date.parse(args.since))) throw new Error("--since must be valid ISO-8601");
  return args;
}

function walkJsonFiles(root, sinceMs) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const recentFlatWindow = sinceMs != null && Date.now() - sinceMs <= 30 * 60_000;
        if (recentFlatWindow && current === root && entry.name === "archive") continue;
        if (sinceMs != null && entry.name.match(/^\d{4}-\d{2}-\d{2}$/)) {
          const dayEnd = Date.parse(`${entry.name}T23:59:59.999Z`);
          if (!Number.isNaN(dayEnd) && dayEnd < sinceMs) continue;
        }
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        if (sinceMs != null) {
          try { if (statSync(full).mtimeMs < sinceMs) continue; } catch { continue; }
        }
        out.push(full);
      }
    }
  }
  return out;
}

function sha256(text) {
  return createHash("sha256").update(text ?? "", "utf8").digest("hex");
}

function deriveOutcome(receipt) {
  if (receipt.execution_outcome) return receipt.execution_outcome;
  if (receipt.error) return "error";
  if (receipt.signal) return "signaled";
  if (receipt.exit_code === 0) return "success";
  if (receipt.exit_code == null) return "unknown";
  return "nonzero_exit";
}

function deriveCompleteness(receipt) {
  if (receipt.evidence_completeness) return receipt.evidence_completeness;
  return receipt.stdout_truncated || receipt.stderr_truncated ? "bounded" : "complete";
}

function retainedBytes(receipt) {
  if (Number.isFinite(receipt.retained_output_bytes)) return receipt.retained_output_bytes;
  const stdoutBytes = Number.isFinite(receipt.retained_stdout_bytes)
    ? receipt.retained_stdout_bytes
    : Buffer.byteLength(receipt.stdout ?? "", "utf8");
  const stderrBytes = Number.isFinite(receipt.retained_stderr_bytes)
    ? receipt.retained_stderr_bytes
    : Buffer.byteLength(receipt.stderr ?? "", "utf8");
  return stdoutBytes + stderrBytes;
}

function receiptTime(receipt) {
  return receipt.finished_at || receipt.started_at || null;
}

function newBucket(callerId) {
  return {
    caller_id: callerId,
    process_count: 0,
    total_retained_output_bytes: 0,
    average_retained_output_bytes: 0,
    completeness: { complete: 0, bounded: 0, unknown: 0 },
    outcomes: { success: 0, nonzero_exit: 0, signaled: 0, error: 0, unknown: 0 },
    missing_request_id_count: 0,
    integrity_metadata_present_count: 0,
    audit_v1_receipt_count: 0,
    non_audit_v1_receipt_count: 0,
    audit_v1_missing_request_id_count: 0,
    audit_v1_missing_integrity_metadata_count: 0,
    hash_verification: { verified: 0, mismatch: 0, unavailable: 0 },
    first_finished_at: null,
    last_finished_at: null,
  };
}

function bumpEnum(target, value) {
  if (Object.hasOwn(target, value)) target[value] += 1;
  else target.unknown += 1;
}

function updateTime(bucket, value) {
  if (!value || Number.isNaN(Date.parse(value))) return;
  if (!bucket.first_finished_at || Date.parse(value) < Date.parse(bucket.first_finished_at)) bucket.first_finished_at = value;
  if (!bucket.last_finished_at || Date.parse(value) > Date.parse(bucket.last_finished_at)) bucket.last_finished_at = value;
}

function coveragePct(present, total) {
  return total ? Math.round((present / total) * 10_000) / 100 : null;
}

function finalizeCoverage(target) {
  target.audit_v1_coverage_pct = coveragePct(target.audit_v1_receipt_count, target.process_count);
  target.request_id_coverage_pct = coveragePct(target.process_count - target.missing_request_id_count, target.process_count);
  target.integrity_metadata_coverage_pct = coveragePct(target.integrity_metadata_present_count, target.process_count);
  target.audit_v1_request_id_coverage_pct = coveragePct(
    target.audit_v1_receipt_count - target.audit_v1_missing_request_id_count,
    target.audit_v1_receipt_count,
  );
  target.audit_v1_integrity_metadata_coverage_pct = coveragePct(
    target.audit_v1_receipt_count - target.audit_v1_missing_integrity_metadata_count,
    target.audit_v1_receipt_count,
  );
  return target;
}

function verifyHashes(receipt) {
  const hasHashes = typeof receipt.stdout_sha256 === "string" && typeof receipt.stderr_sha256 === "string";
  if (!hasHashes || typeof receipt.stdout !== "string" || typeof receipt.stderr !== "string") return "unavailable";
  return sha256(receipt.stdout) === receipt.stdout_sha256 && sha256(receipt.stderr) === receipt.stderr_sha256 ? "verified" : "mismatch";
}

function chooseDedup(existing, candidate) {
  if (!existing) return candidate;
  const a = receiptTime(existing.receipt);
  const b = receiptTime(candidate.receipt);
  if (a && b && Date.parse(b) > Date.parse(a)) return candidate;
  const aMtime = existing.mtimeMs ?? 0;
  const bMtime = candidate.mtimeMs ?? 0;
  return bMtime > aMtime ? candidate : existing;
}

function summarize(receiptDir, since) {
  const sinceMs = since ? Date.parse(since) : null;
  const files = walkJsonFiles(receiptDir, sinceMs);
  const dedup = new Map();
  let malformedFiles = 0;
  let nonReceiptJsonFiles = 0;
  for (const file of files) {
    let receipt;
    try { receipt = JSON.parse(readFileSync(file, "utf8")); }
    catch { malformedFiles += 1; continue; }
    if (!receipt || typeof receipt.process_id !== "string") { nonReceiptJsonFiles += 1; continue; }
    const at = receiptTime(receipt);
    if (sinceMs != null && (!at || Number.isNaN(Date.parse(at)) || Date.parse(at) < sinceMs)) continue;
    const candidate = { receipt, file, mtimeMs: statSync(file).mtimeMs };
    dedup.set(receipt.process_id, chooseDedup(dedup.get(receipt.process_id), candidate));
  }

  const totals = {
    process_count: 0,
    total_retained_output_bytes: 0,
    average_retained_output_bytes: 0,
    completeness: { complete: 0, bounded: 0, unknown: 0 },
    outcomes: { success: 0, nonzero_exit: 0, signaled: 0, error: 0, unknown: 0 },
    missing_request_id_count: 0,
    integrity_metadata_present_count: 0,
    audit_v1_receipt_count: 0,
    non_audit_v1_receipt_count: 0,
    audit_v1_missing_request_id_count: 0,
    audit_v1_missing_integrity_metadata_count: 0,
    hash_verification: { verified: 0, mismatch: 0, unavailable: 0 },
    first_finished_at: null,
    last_finished_at: null,
  };
  const callers = new Map();

  for (const { receipt } of dedup.values()) {
    const callerId = typeof receipt.caller_id === "string" && receipt.caller_id ? receipt.caller_id : "(missing)";
    const bucket = callers.get(callerId) || newBucket(callerId);
    callers.set(callerId, bucket);
    const bytes = retainedBytes(receipt);
    const completeness = deriveCompleteness(receipt);
    const outcome = deriveOutcome(receipt);
    const hashState = verifyHashes(receipt);
    const hasIntegrity = typeof receipt.stdout_sha256 === "string" && typeof receipt.stderr_sha256 === "string";
    const hasAuditV1 = receipt.audit_schema === "process-output-evidence.v1";

    for (const target of [totals, bucket]) {
      target.process_count += 1;
      target.total_retained_output_bytes += bytes;
      bumpEnum(target.completeness, completeness);
      bumpEnum(target.outcomes, outcome);
      if (hasAuditV1) target.audit_v1_receipt_count += 1;
      else target.non_audit_v1_receipt_count += 1;
      if (!receipt.request_id) {
        target.missing_request_id_count += 1;
        if (hasAuditV1) target.audit_v1_missing_request_id_count += 1;
      }
      if (hasIntegrity) target.integrity_metadata_present_count += 1;
      else if (hasAuditV1) target.audit_v1_missing_integrity_metadata_count += 1;
      target.hash_verification[hashState] += 1;
      updateTime(target, receiptTime(receipt));
    }
  }

  totals.average_retained_output_bytes = totals.process_count
    ? Math.round(totals.total_retained_output_bytes / totals.process_count)
    : 0;
  finalizeCoverage(totals);
  const callerRows = [...callers.values()].map((bucket) => finalizeCoverage({
    ...bucket,
    average_retained_output_bytes: bucket.process_count
      ? Math.round(bucket.total_retained_output_bytes / bucket.process_count)
      : 0,
  })).sort((a, b) => b.process_count - a.process_count || a.caller_id.localeCompare(b.caller_id));

  return {
    schema: "process-evidence-audit-summary.v1",
    generated_at: new Date().toISOString(),
    semantics: {
      aggregate_only: true,
      raw_stdout_stderr_emitted: false,
      semantic_work_quality_scored: false,
      execution_outcome_is_process_status_not_task_quality: true,
      caller_id_is_opaque_not_named_worker_identity: true,
      non_audit_v1_receipt_is_not_automatically_a_current_evidence_failure: true,
    },
    source: {
      receipt_dir: path.resolve(receiptDir),
      since: since || null,
      scanned_json_files: files.length,
      malformed_json_files: malformedFiles,
      non_receipt_json_files: nonReceiptJsonFiles,
      deduplicated_process_receipts: dedup.size,
    },
    totals,
    callers: callerRows,
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  console.log(JSON.stringify(summarize(args.receiptDir, args.since), null, 2));
} catch (error) {
  console.error(`audit-process-evidence: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
