import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "capture-edge-backend-correlation-"));
const edgePath = join(temporary, "edge.jsonl");
const transportPath = join(temporary, "transport.jsonl");
const wrapper = fileURLToPath(new URL("./capture-edge-backend-correlation.mjs", import.meta.url));
const start = "2026-09-05T00:00:00.000Z";
const end = "2026-09-05T00:01:00.000Z";
const requestId = "secret-wrapper-request";
const session = "secret-wrapper-session";
const authorization = "Bearer secret-wrapper-auth";
const base = Date.parse(start) / 1000;

function edge(ts, method, uri, id, duration, status) {
  const resp_headers = {};
  if (id) resp_headers["X-Shell-Mcp-Request-Id"] = [id];
  return JSON.stringify({
    ts,
    request: {
      remote_ip: "1.2.3.4",
      remote_port: "12345",
      method,
      uri,
      headers: { Authorization: [authorization], "X-Openai-Session": [session] },
    },
    resp_headers,
    duration,
    status,
  });
}

try {
  writeFileSync(edgePath, [
    edge(base - 1, "GET", "/health", undefined, 0.001, 200),
    edge(base + 10, "POST", "/mcp", requestId, 0.120, 200),
    edge(base + 61, "GET", "/health", undefined, 0.001, 200),
  ].join("\n") + "\n", "utf8");
  writeFileSync(transportPath, `${JSON.stringify({ event: "response_finish", at: "2026-09-05T00:00:10.000Z", request_id: requestId, duration_ms: 100, status: 200 })}\n`, "utf8");

  const stdout = execFileSync(process.execPath, [wrapper, "--input", edgePath, "--transport", transportPath, "--start", start, "--end", end, "--lines", "100"], { encoding: "utf8", windowsHide: true });
  const report = JSON.parse(stdout);
  assert.equal(report.edge_source_window.requested_start_covered, true);
  assert.equal(report.edge_source_window.requested_end_covered, true);
  assert.equal(report.edge_mcp_posts, 1);
  assert.equal(report.matched_requests, 1);
  assert.equal(report.status_mismatches, 0);
  assert.equal(report.edge_minus_backend_duration_ms.max, 20);
  assert.equal(report.privacy.raw_request_ids_emitted, false);
  for (const secret of [requestId, session, authorization, "1.2.3.4"]) assert.ok(!stdout.includes(secret), `wrapper leaked raw identifier: ${secret}`);

  const invalid = spawnSync(process.execPath, [wrapper, "--input", edgePath, "--transport", transportPath, "--start", start, "--end", end, "--lines", "99"], { encoding: "utf8", windowsHide: true });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /--lines must be an integer from 100 through 20000/);
  console.log("PASS capture_edge_backend_correlation wrapper_invocation=true stdin_edge=true raw_edge_not_emitted=true source_coverage_visible=true");
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}
