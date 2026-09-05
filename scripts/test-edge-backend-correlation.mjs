import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "edge-backend-correlation-"));
const edgePath = join(temporary, "edge.jsonl");
const backendPath = join(temporary, "transport.jsonl");
const analyzer = fileURLToPath(new URL("./analyze-edge-backend-correlation.mjs", import.meta.url));
const start = "2026-09-05T00:00:00.000Z";
const end = "2026-09-05T00:01:00.000Z";

function edge(tsSeconds, requestId, durationSeconds, status) {
  const resp_headers = {};
  if (requestId) resp_headers["X-Shell-Mcp-Request-Id"] = [requestId];
  return JSON.stringify({
    ts: tsSeconds,
    request: { method: "POST", uri: "/mcp" },
    resp_headers,
    duration: durationSeconds,
    status,
  });
}

function backend(at, requestId, durationMs, status) {
  return JSON.stringify({ event: "response_finish", at, request_id: requestId, duration_ms: durationMs, status });
}

function edgeOther(tsSeconds) {
  return JSON.stringify({ ts: tsSeconds, request: { method: "GET", uri: "/health" }, duration: 0.001, status: 200 });
}

try {
  const baseSeconds = Date.parse(start) / 1000;
  const edgePayload = [
    edgeOther(baseSeconds - 1),
    edge(baseSeconds + 10, "secret-request-a", 0.100, 200),
    edge(baseSeconds + 20, "secret-request-b", 0.300, 200),
    edge(baseSeconds + 30, "secret-request-c", 0.050, 202),
    edge(baseSeconds + 40, "secret-request-missing", 0.100, 200),
    edge(baseSeconds + 50, undefined, 0.075, 200),
    edgeOther(baseSeconds + 61),
    "{malformed",
  ].join("\n") + "\n";
  writeFileSync(edgePath, edgePayload, "utf8");
  writeFileSync(backendPath, [
    backend("2026-09-05T00:00:10.000Z", "secret-request-a", 80, 200),
    backend("2026-09-05T00:00:20.000Z", "secret-request-b", 150, 200),
    backend("2026-09-05T00:00:30.000Z", "secret-request-c", 45, 202),
    backend("2026-09-05T00:00:35.000Z", "secret-request-unrelated", 10, 200),
    "{malformed",
  ].join("\n") + "\n", "utf8");

  const stdout = execFileSync(process.execPath, [analyzer, edgePath, backendPath, start, end], { encoding: "utf8", windowsHide: true });
  const report = JSON.parse(stdout);
  assert.equal(report.edge_source_window.timestamped_rows, 7);
  assert.equal(report.edge_source_window.requested_start_covered, true);
  assert.equal(report.edge_source_window.requested_end_covered, true);
  assert.equal(report.edge_mcp_posts, 5);
  assert.equal(report.edge_posts_with_request_id, 4);
  assert.equal(report.edge_posts_without_request_id, 1);
  assert.equal(report.backend_response_candidates, 4);
  assert.equal(report.matched_requests, 3);
  assert.equal(report.unmatched_edge_requests, 1);
  assert.equal(report.status_mismatches, 0);
  assert.deepEqual(report.malformed_lines, { edge: 1, backend: 1 });
  assert.deepEqual(report.edge_minus_backend_duration_ms, { count: 3, min: 5, p50: 20, p95: 150, p99: 150, max: 150 });
  assert.deepEqual(report.proxy_overhead_thresholds, { over_50ms: 1, over_100ms: 1, over_250ms: 0, below_minus_10ms: 0 });
  assert.equal(report.privacy.raw_request_ids_emitted, false);

  const stdinStdout = execFileSync(process.execPath, [analyzer, "-", backendPath, start, end], { input: edgePayload, encoding: "utf8", windowsHide: true });
  const stdinReport = JSON.parse(stdinStdout);
  assert.deepEqual(stdinReport, report);

  for (const secret of ["secret-request-a", "secret-request-b", "secret-request-c", "secret-request-missing", "secret-request-unrelated"]) {
    assert.ok(!stdout.includes(secret), `aggregate output leaked request id: ${secret}`);
  }
  console.log("PASS edge_backend_correlation matched_requests=true status_check=true proxy_overhead=true stdin_edge=true source_coverage=true raw_request_ids_emitted=false");
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}
