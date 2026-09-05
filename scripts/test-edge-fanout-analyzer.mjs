import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "edge-fanout-analyzer-"));
const logPath = join(temporary, "caddy.jsonl");
const sessionA = "secret-session-A";
const sessionB = "secret-session-B";
const subject = "secret-subject";
const authorization = "Bearer secret-token";

function row({ ts, ip, port, session, status, resumed = false, connection = "keep-alive", duration, size, method = "POST", uri = "/mcp" }) {
  const headers = {
    Connection: [connection],
    Authorization: [authorization],
    "X-Openai-Subject": [subject],
  };
  if (session) headers["X-Openai-Session"] = [session];
  return JSON.stringify({
    ts,
    request: {
      remote_ip: ip,
      remote_port: String(port),
      proto: "HTTP/1.1",
      method,
      uri,
      headers,
      tls: { resumed },
    },
    duration,
    size,
    status,
  });
}

try {
  const lines = [
    row({ ts: 1000, ip: "1.1.1.1", port: 111, session: sessionA, status: 200, duration: 1, size: 100 }),
    row({ ts: 1001, ip: "1.1.1.1", port: 111, session: sessionA, status: 200, duration: 2, size: 200 }),
    row({ ts: 1002, ip: "2.2.2.2", port: 222, session: sessionA, status: 202, resumed: true, duration: 3, size: 300 }),
    row({ ts: 1003, ip: "3.3.3.3", port: 333, session: sessionB, status: 200, connection: "close", duration: 4, size: 400 }),
    row({ ts: 1004, ip: "4.4.4.4", port: 444, status: 502, connection: "", duration: 5, size: 500 }),
    row({ ts: 1005, ip: "5.5.5.5", port: 555, session: sessionB, status: 200, duration: 6, size: 600, method: "GET", uri: "/health" }),
    "{malformed",
  ];
  writeFileSync(logPath, `${lines.join("\n")}\n`, "utf8");
  const analyzer = fileURLToPath(new URL("./analyze-edge-fanout.mjs", import.meta.url));
  const stdout = execFileSync(process.execPath, [analyzer, logPath], { encoding: "utf8", windowsHide: true });
  const report = JSON.parse(stdout);

  assert.equal(report.mcp_posts, 5);
  assert.equal(report.malformed_lines, 1);
  assert.deepEqual(report.status_counts, { 200: 3, 202: 1, 502: 1 });
  assert.deepEqual(report.request_contract, { http_1_1_posts: 5, keep_alive_posts: 3 });
  assert.equal(report.public_connections.unique_sockets, 4);
  assert.equal(report.public_connections.requests_per_socket, 1.25);
  assert.equal(report.public_connections.reused_sockets, 1);
  assert.equal(report.public_connections.max_requests_per_socket, 2);
  assert.equal(report.public_connections.unique_remote_ips, 4);
  assert.equal(report.public_connections.tls_resumed_requests, 1);
  assert.equal(report.public_connections.tls_resumed_sockets, 1);
  assert.equal(report.openai_sessions.unique_sessions, 2);
  assert.equal(report.openai_sessions.attributed_posts, 4);
  assert.equal(report.openai_sessions.unattributed_posts, 1);
  assert.equal(report.openai_sessions.consecutive_pairs, 2);
  assert.equal(report.openai_sessions.socket_changes, 1);
  assert.equal(report.openai_sessions.socket_change_rate, 0.5);
  assert.equal(report.openai_sessions.remote_ip_changes, 1);
  assert.equal(report.openai_sessions.remote_ip_change_rate, 0.5);
  assert.deepEqual(report.openai_sessions.busiest_session, {
    requests: 3,
    unique_sockets: 2,
    unique_remote_ips: 2,
    consecutive_pairs: 2,
    socket_changes: 1,
    remote_ip_changes: 1,
  });
  assert.equal(report.response.bytes, 1500);
  assert.deepEqual(report.response.duration_seconds, { count: 5, p50: 3, p95: 5, p99: 5, max: 5 });
  assert.equal(report.privacy.raw_identifiers_emitted, false);

  for (const secret of [sessionA, sessionB, subject, authorization, "1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"]) {
    assert.ok(!stdout.includes(secret), `aggregate output leaked raw identifier: ${secret}`);
  }

  const filteredStdout = execFileSync(process.execPath, [analyzer, logPath, "--since", new Date(1002 * 1000).toISOString(), "--until", new Date(1004 * 1000).toISOString()], { encoding: "utf8", windowsHide: true });
  const filtered = JSON.parse(filteredStdout);
  assert.equal(filtered.mcp_posts, 3);
  assert.deepEqual(filtered.status_counts, { 202: 1, 200: 1, 502: 1 });

  const stdinStdout = execFileSync(process.execPath, [analyzer, "-"], { input: `${lines.join("\n")}\n`, encoding: "utf8", windowsHide: true });
  const stdinReport = JSON.parse(stdinStdout);
  assert.deepEqual(stdinReport, report);
  for (const secret of [sessionA, sessionB, subject, authorization, "1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"]) {
    assert.ok(!stdinStdout.includes(secret), `stdin aggregate output leaked raw identifier: ${secret}`);
  }

  console.log("PASS edge_fanout_analyzer aggregate_only=true window_filter=true stdin_stream=true session_socket_metrics=true raw_identifiers_leaked=false");
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}
