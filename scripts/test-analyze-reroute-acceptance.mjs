import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "reroute-acceptance-"));
const transportPath = join(temporary, "transport.jsonl");
const routingPath = join(temporary, "routing.jsonl");
const analyzer = fileURLToPath(new URL("./analyze-reroute-acceptance.mjs", import.meta.url));
const start = "2026-09-06T14:52:42.474Z";
const end = "2026-09-06T15:22:42.474Z";

function t(at, event, fields = {}) { return JSON.stringify({ at, event, ...fields }); }
function r(fields) { return JSON.stringify({ schema: "mcp-security-routing-event.v2", ...fields }); }
function run() {
  return JSON.parse(execFileSync(process.execPath, [analyzer, transportPath, routingPath, start, end, "--bin-minutes", "15"], { encoding: "utf8", windowsHide: true }));
}

try {
  const transportArchive = `${transportPath}.archive`;
  mkdirSync(transportArchive, { recursive: true });
  const archivedStart = t("2026-09-06T14:53:00.000Z", "response_finish", { request_id: "request-a", caller_id: "caller-a", session_id: "session-a", connection_id: "connection-a", method: "POST", path: "/mcp", mcp_method: "tools/call", mcp_tool: "start_process", status: 200, duration_ms: 1000 });
  writeFileSync(join(transportArchive, "transport.jsonl.2026-09-06T15-00-00-000Z.fixture-a.jsonl"), [
    archivedStart,
    t("2026-09-06T14:53:30.000Z", "response_finish", { request_id: "request-archive-only", caller_id: "caller-a", session_id: "session-a", connection_id: "connection-archive", method: "POST", path: "/mcp", mcp_method: "tools/call", mcp_tool: "read_output", status: 200, duration_ms: 500 }),
  ].join("\n") + "\n", "utf8");
  writeFileSync(join(transportArchive, "transport.jsonl.2026-09-06T14-00-00-000Z.fixture-old.jsonl"), [
    t("2026-09-06T13:59:59.000Z", "response_finish", { request_id: "request-old", caller_id: "caller-old", connection_id: "connection-old", method: "POST", path: "/mcp", mcp_method: "tools/call", mcp_tool: "start_process", status: 200, duration_ms: 1 }),
  ].join("\n") + "\n", "utf8");
  writeFileSync(transportPath, [
    t("2026-09-06T14:52:42.474Z", "response_finish", { request_id: "request-list", caller_id: "caller-refresh", connection_id: "connection-refresh", method: "POST", path: "/mcp", mcp_method: "tools/list", status: 200, duration_ms: 89.9 }),
    archivedStart,
    t("2026-09-06T14:54:00.000Z", "response_finish", { request_id: "request-b", caller_id: "caller-a", session_id: "session-a", connection_id: "connection-b", method: "POST", path: "/mcp", mcp_method: "tools/call", mcp_tool: "read_output", status: 200, duration_ms: 10010 }),
    t("2026-09-06T15:08:00.000Z", "response_finish", { request_id: "request-c", caller_id: "caller-b", session_id: "session-b", connection_id: "connection-c", method: "POST", path: "/mcp", mcp_method: "tools/call", mcp_tool: "kill_process", status: 200, duration_ms: 200 }),
    t("2026-09-06T15:09:00.000Z", "response_finish", { request_id: "request-non-tool", caller_id: "caller-b", connection_id: "connection-c", method: "GET", path: "/", mcp_method: null, mcp_tool: null, status: 404, duration_ms: 2 }),
    "{malformed",
  ].join("\n") + "\n", "utf8");

  // Offset regression: 17:31 EEST is 14:31 UTC, before the 14:52 UTC refresh.
  // Even if its report is written after refresh, exact event_time wins and must not create a false recurrence.
  writeFileSync(routingPath, [
    r({ reported_at: "2026-09-06T15:00:00Z", classification: "direct_platform_block", event_time_known: true, event_time: "2026-09-06T17:31:00+03:00" }),
    r({ reported_at: "2026-09-06T15:05:00Z", classification: "same_operation_retry_counterexample" }),
  ].join("\n") + "\n", "utf8");

  let report = run();
  assert.equal(report.acceptance.status, "CLEAN_OBSERVED_WINDOW");
  assert.equal(report.transport.source_file_count, 2);
  assert.deepEqual(report.transport.archive_segments_skipped_before_window, ["transport.jsonl.2026-09-06T14-00-00-000Z.fixture-old.jsonl"]);
  assert.equal(report.transport.duplicate_response_finish_rows_skipped, 1);
  assert.equal(report.transport.process_tool_calls.total, 4);
  assert.equal(report.transport.process_tool_calls.status_200, 4);
  assert.equal(report.transport.process_tool_calls.non_2xx, 0);
  assert.equal(report.transport.process_tool_calls.unique_callers, 2);
  assert.equal(report.transport.process_tool_calls.unique_sessions, 2);
  assert.equal(report.transport.process_tool_calls.unique_connections, 4);
  assert.equal(report.transport.process_tool_calls.first_at, "2026-09-06T14:53:00.000Z");
  assert.equal(report.transport.process_tool_calls.last_at, "2026-09-06T15:08:00.000Z");
  assert.equal(report.transport.process_tool_calls.observation_span_minutes, 15);
  assert.equal(report.transport.process_tool_calls.active_bins, 2);
  assert.equal(report.transport.process_tool_calls.total_bins, 2);
  assert.equal(report.transport.process_tool_calls.active_bin_fraction, 1);
  assert.equal(report.transport.process_tool_calls.by_tool.read_output.total, 2);
  assert.equal(report.transport.process_tool_calls.by_tool.read_output.duration_ms.p95, 10010);
  assert.deepEqual(report.transport.response_method_counts, { "non_mcp": 1, "tools/call": 4, "tools/list": 1 });
  assert.equal(report.transport.bins.length, 2);
  assert.equal(report.transport.bins[0].process_tool_calls, 3);
  assert.equal(report.transport.bins[1].process_tool_calls, 1);
  assert.equal(report.routing_events.known_event_time_adverse_in_window, 0);
  assert.deepEqual(report.routing_events.known_event_time_adverse_families, {});
  assert.equal(report.routing_events.unknown_event_time_adverse_reports_received_in_window, 0);
  assert.deepEqual(report.routing_events.unknown_event_time_adverse_report_families, {});
  assert.equal(report.routing_events.normalized_rates_per_1000_process_tool_calls.denominator_process_tool_calls, 4);
  assert.equal(report.routing_events.normalized_rates_per_1000_process_tool_calls.known_event_time_adverse, 0);
  assert.equal(report.routing_events.normalized_rates_per_1000_process_tool_calls.unknown_event_time_adverse_reports_received, 0);
  assert.equal(report.acceptance.transport_clean, true);

  // An adverse report received inside the window with unknown occurrence time cannot be assigned before/after.
  writeFileSync(routingPath, [
    r({ reported_at: "2026-09-06T15:10:00Z", classification: "user_observed_security_reroute_persists", event_time_known: false, event_time: null }),
  ].join("\n") + "\n", "utf8");
  report = run();
  assert.equal(report.acceptance.status, "INDETERMINATE_UNKNOWN_EVENT_TIME");
  assert.equal(report.routing_events.known_event_time_adverse_in_window, 0);
  assert.deepEqual(report.routing_events.known_event_time_adverse_families, {});
  assert.equal(report.routing_events.unknown_event_time_adverse_reports_received_in_window, 1);
  assert.deepEqual(report.routing_events.unknown_event_time_adverse_report_families, { user_visible_or_above_mcp: 1 });
  assert.equal(report.routing_events.normalized_rates_per_1000_process_tool_calls.unknown_event_time_adverse_reports_received, 250);
  assert.deepEqual(report.routing_events.normalized_rates_per_1000_process_tool_calls.unknown_event_time_adverse_report_families, { user_visible_or_above_mcp: 250 });
  assert.equal(report.acceptance.unknown_event_time_adverse_report_present, true);

  // A known-time direct block inside the window is a recurrence; attempts_blocked must be counted.
  writeFileSync(routingPath, [
    r({ reported_at: "2026-09-06T15:12:01Z", classification: "assistant_observed_direct_read_output_security_block", event_time_known: true, event_time: "2026-09-06T15:12:00Z", operation: { attempts_blocked: 2, process_id: "secret-process-id" } }),
  ].join("\n") + "\n", "utf8");
  report = run();
  assert.equal(report.acceptance.status, "RECURRENCE_OBSERVED");
  assert.equal(report.routing_events.known_event_time_adverse_in_window, 1);
  assert.deepEqual(report.routing_events.known_event_time_adverse_families, { direct_tool_block: 1 });
  assert.equal(report.routing_events.known_direct_block_attempts_in_window, 2);
  assert.deepEqual(report.routing_events.known_event_time_adverse_classifications, { assistant_observed_direct_read_output_security_block: 1 });
  assert.equal(report.routing_events.normalized_rates_per_1000_process_tool_calls.known_event_time_adverse, 250);
  assert.equal(report.routing_events.normalized_rates_per_1000_process_tool_calls.known_direct_block_attempts, 500);
  assert.deepEqual(report.routing_events.normalized_rates_per_1000_process_tool_calls.known_event_time_adverse_families, { direct_tool_block: 250 });

  const serialized = JSON.stringify(report);
  for (const forbidden of ["request-a", "caller-a", "session-a", "connection-a", "secret-process-id"]) {
    assert.equal(serialized.includes(forbidden), false, `raw identifier leaked: ${forbidden}`);
  }

  // Non-MCP 404s are not connector degradation, but process-tool non-2xx and actual transport errors are.
  writeFileSync(routingPath, "", "utf8");
  rmSync(transportArchive, { recursive: true, force: true });
  writeFileSync(transportPath, [
    t("2026-09-06T15:00:00.000Z", "request_error", { request_id: "request-error", caller_id: "caller-error", connection_id: "connection-error", method: "POST", path: "/mcp", mcp_method: "tools/call", mcp_tool: "read_output", code: "ECONNRESET" }),
    t("2026-09-06T15:00:00.010Z", "response_finish", { request_id: "request-error", caller_id: "caller-error", session_id: "session-error", connection_id: "connection-error", method: "POST", path: "/mcp", mcp_method: "tools/call", mcp_tool: "read_output", status: 503, duration_ms: 10 }),
  ].join("\n") + "\n", "utf8");
  report = run();
  assert.equal(report.acceptance.status, "TRANSPORT_DEGRADED");
  assert.equal(report.acceptance.transport_clean, false);
  assert.equal(report.transport.transport_error_events, 1);
  assert.equal(report.transport.process_tool_calls.non_2xx, 1);
  assert.deepEqual(report.transport.non_2xx_response_groups, { "503|tools/call|read_output|/mcp": 1 });

  // An empty observation source must fail closed instead of becoming a vacuous clean window.
  writeFileSync(transportPath, t("2026-09-06T15:00:00.000Z", "response_finish", { request_id: "request-health", method: "GET", path: "/health", mcp_method: null, status: 200, duration_ms: 1 }) + "\n", "utf8");
  report = run();
  assert.equal(report.acceptance.status, "NO_PROCESS_TOOL_EVIDENCE");
  assert.equal(report.acceptance.process_tool_evidence_present, false);
  assert.equal(report.transport.process_tool_calls.total, 0);
  assert.equal(report.transport.process_tool_calls.first_at, null);
  assert.equal(report.transport.process_tool_calls.last_at, null);
  assert.equal(report.transport.process_tool_calls.observation_span_minutes, 0);
  assert.equal(report.transport.process_tool_calls.active_bins, 0);
  assert.equal(report.routing_events.normalized_rates_per_1000_process_tool_calls.denominator_process_tool_calls, 0);
  assert.equal(report.routing_events.normalized_rates_per_1000_process_tool_calls.known_event_time_adverse, null);
  assert.equal(report.routing_events.normalized_rates_per_1000_process_tool_calls.unknown_event_time_adverse_reports_received, null);

  console.log("PASS reroute_acceptance exact_event_time=true unknown_time_indeterminate=true transport_joined=true transport_degradation=true no_vacuous_clean=true raw_identifiers_emitted=false");
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}
