import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "capture-edge-fanout-"));
const inputPath = join(temporary, "edge.jsonl");
const wrapper = fileURLToPath(new URL("./capture-edge-fanout.mjs", import.meta.url));
const session = "secret-session-wrapper";
const authorization = "Bearer secret-wrapper-token";

function row(ts, ip, port, status = 200) {
  return JSON.stringify({
    ts,
    request: {
      remote_ip: ip,
      remote_port: String(port),
      proto: "HTTP/1.1",
      method: "POST",
      uri: "/mcp",
      headers: { Connection: ["keep-alive"], Authorization: [authorization], "X-Openai-Session": [session] },
      tls: { resumed: false },
    },
    duration: 0.01,
    size: 100,
    status,
  });
}

try {
  const base = Date.parse("2026-09-05T00:00:00.000Z") / 1000;
  writeFileSync(inputPath, `${row(base + 1, "1.1.1.1", 1001)}\n${row(base + 2, "2.2.2.2", 1002)}\n`, "utf8");
  const stdout = execFileSync(process.execPath, [wrapper, "--input", inputPath, "--since", "2026-09-05T00:00:00.000Z", "--until", "2026-09-05T00:01:00.000Z"], { encoding: "utf8", windowsHide: true });
  const report = JSON.parse(stdout);
  assert.equal(report.mcp_posts, 2);
  assert.equal(report.status_counts["200"], 2);
  assert.equal(report.source_window.requested_since_covered, false);
  assert.equal(report.source_window.requested_until_covered, false);
  assert.equal(report.public_connections.unique_sockets, 2);
  assert.equal(report.openai_sessions.unique_sessions, 1);
  assert.equal(report.privacy.raw_identifiers_emitted, false);
  for (const secret of [session, authorization, "1.1.1.1", "2.2.2.2"]) assert.ok(!stdout.includes(secret), `wrapper leaked raw identifier: ${secret}`);

  const invalid = spawnSync(process.execPath, [wrapper, "--lines", "99", "--input", inputPath], { encoding: "utf8", windowsHide: true });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /--lines must be an integer from 100 through 20000/);
  console.log("PASS capture_edge_fanout wrapper_invocation=true stdin_aggregate=true raw_log_not_emitted=true bounded_lines=true source_coverage_visible=true");
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}
