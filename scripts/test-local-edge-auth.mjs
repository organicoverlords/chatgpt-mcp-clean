import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unusedPort = () => new Promise((resolvePort, reject) => {
  const s = createNetServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const a = s.address(); const port = typeof a === "object" && a ? a.port : 0;
    s.close((e) => e ? reject(e) : resolvePort(port));
  });
});
const request = (origin, path, host, headers = {}) => new Promise((resolveRequest, reject) => {
  const r = httpRequest(new URL(path, origin), { headers: { Host: host, ...headers } }, (res) => {
    let text = ""; res.setEncoding("utf8"); res.on("data", c => { text += c; });
    res.on("end", () => resolveRequest({ status: res.statusCode ?? 0, text }));
  });
  r.once("error", reject); r.end();
});

const temp = mkdtempSync(join(tmpdir(), "mcp-local-edge-"));
const port = await unusedPort();
const loopback = `http://127.0.0.1:${port}`;
const publicOrigin = "https://local-edge.test";
const publicHost = new URL(publicOrigin).host;
const child = spawn(process.execPath, [resolve("dist/index.js")], {
  cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MCP_BACKEND_MODE: "1",
    MCP_TOOL_PROFILE: "process", MCP_PUBLIC_ORIGIN: publicOrigin, MCP_OWNER_AUTH_ORIGIN: "",
    MCP_OWNER_AUTH_MODE: "local-edge", TAILSCALE_OWNER_LOGIN: "owner@example.com",
    MCP_OAUTH_STORE_PATH: join(temp,"oauth.json"), MCP_TRANSPORT_LOG_PATH: join(temp,"transport.jsonl"),
    MCP_PROCESS_RECEIPT_DIR: join(temp,"receipts"), MCP_RUNTIME_INSTANCE_ID: "", MCP_RUNTIME_SOURCE_COMMIT: "",
    MCP_RUNTIME_DIST_SHA256: "", MCP_RUNTIME_SOURCE_DIRTY: "" }
});
let stderr = ""; child.stderr.on("data", c => { stderr += c.toString(); });
try {
  const deadline = Date.now() + 15000; let healthy = false;
  while (Date.now() < deadline) { try { const r = await fetch(`${loopback}/health`); if (r.ok) { healthy=true; break; } } catch {} await sleep(100); }
  assert.equal(healthy, true, stderr);
  const metadata = await fetch(`${loopback}/.well-known/oauth-authorization-server`).then(r => r.json());
  assert.equal(metadata.authorization_endpoint, `${publicOrigin}/authorize`);
  const local = await request(loopback, "/authorize", publicHost);
  assert.equal(local.status, 400, local.text);
  assert.doesNotMatch(local.text, /Owner authorization required/);
  const wrongHost = await request(loopback, "/authorize", "wrong-host.test");
  assert.equal(wrongHost.status, 403, wrongHost.text);
  console.log("PASS local_edge_auth local_authorize_reaches_oauth=true wrong_host_blocked=true");
} finally {
  if (child.exitCode === null) child.kill();
  await new Promise(r => child.exitCode !== null ? r() : child.once("exit", r));
  rmSync(temp, { recursive: true, force: true });
}
