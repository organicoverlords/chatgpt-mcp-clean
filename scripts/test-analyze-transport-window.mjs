import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "transport-window-analyzer-"));
const logPath = join(temporary, "transport.jsonl");
const analyzer = fileURLToPath(new URL("./analyze-transport-window.mjs", import.meta.url));

function event(atMs, eventName, fields = {}) {
  return JSON.stringify({ at: new Date(atMs).toISOString(), event: eventName, ...fields });
}

try {
  const base = Date.parse("2026-09-05T00:00:00.000Z");
  const lines = [
    event(base + 100, "process_wait_requested", { request_id: "request-a", requested_wait_ms: 1000 }),
    event(base + 1120, "response_finish", { request_id: "request-a", status: 200, mcp_tool: "read_output", duration_ms: 1020 }),
    event(base + 2000, "process_wait_requested", { request_id: "request-b", requested_wait_ms: 1000 }),
    event(base + 3400, "response_finish", { request_id: "request-b", status: 200, mcp_tool: "read_output", duration_ms: 1400 }),
    event(base + 4000, "process_wait_requested", { request_id: "request-c", requested_wait_ms: 5000 }),
    event(base + 5000, "response_finish", { request_id: "request-c", status: 200, mcp_tool: "start_process", duration_ms: 1000 }),
    event(base + 6000, "response_finish", { request_id: "request-no-wait", status: 200, mcp_tool: "start_process", duration_ms: 50 }),
    "{malformed",
  ];
  writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
  const stdout = execFileSync(process.execPath, [analyzer, logPath, new Date(base).toISOString(), new Date(base + 10_000).toISOString()], { encoding: "utf8", windowsHide: true });
  const report = JSON.parse(stdout);
  assert.equal(report.selected_events, 7);
  assert.equal(report.malformed_lines, 1);
  assert.deepEqual(report.response_status_counts, { 200: 4 });
  assert.deepEqual(report.response_tool_counts, { read_output: 2, start_process: 2 });
  assert.deepEqual(report.response_duration_ms, { count: 4, max: 1400, p50: 1000, p95: 1400, p99: 1400 });
  assert.deepEqual(report.response_wait_attribution, {
    matched_responses: 3,
    near_requested_wait_ceiling_250ms: 2,
    over_requested_wait_250ms: 1,
    over_requested_wait_500ms: 0,
    requested_wait_ms: { count: 3, p50: 1000, p95: 5000, p99: 5000, max: 5000 },
    duration_minus_requested_wait_ms: { count: 3, min: -4000, p50: 20, p95: 400, p99: 400, max: 400 },
    by_tool: {
      read_output: { matched_responses: 2, near_requested_wait_ceiling_250ms: 2, over_requested_wait_250ms: 1, over_requested_wait_500ms: 0, max_positive_excess_ms: 400 },
      start_process: { matched_responses: 1, near_requested_wait_ceiling_250ms: 0, over_requested_wait_250ms: 0, over_requested_wait_500ms: 0, max_positive_excess_ms: 0 },
    },
  });
  assert.ok(!stdout.includes("request-a"));
  assert.ok(!stdout.includes("request-b"));
  assert.ok(!stdout.includes("request-c"));
  console.log("PASS transport_window_wait_attribution matched_by_request=true ceiling_vs_excess=true raw_request_ids_emitted=false");
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}
