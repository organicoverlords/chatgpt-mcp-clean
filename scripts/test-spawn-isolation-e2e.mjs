import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
async function unusedPort() {
  return await new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}
async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, text, body };
}
const temporary = mkdtempSync(join(tmpdir(), "mcp-spawn-e2e-"));
const port = await unusedPort();
const origin = `http://127.0.0.1:${port}`;
const publicOrigin = "https://spawn-isolation.test.ts.net";
const server = spawn(process.execPath, [resolve("dist/index.js")], {
  cwd: resolve("."),
  env: {
    ...process.env,
    PORT: String(port), HOST: "127.0.0.1", MCP_BACKEND_MODE: "1", MCP_TOOL_PROFILE: "process",
    MCP_PUBLIC_ORIGIN: publicOrigin, TAILSCALE_OWNER_LOGIN: "owner@example.com",
    MCP_OAUTH_STORE_PATH: join(temporary, "oauth.json"), MCP_TRANSPORT_LOG_PATH: join(temporary, "transport.jsonl"),
    MCP_PROCESS_RECEIPT_DIR: join(temporary, "receipts"), MCP_TEST_LAUNCH_DELAY_MS: "3000",
  },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let serverStderr = "";
server.stderr.on("data", (chunk) => { serverStderr += chunk.toString(); });
async function waitHealth() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${origin}/health`); if (r.ok) return; } catch {}
    await sleep(50);
  }
  throw new Error(`server health timeout: ${serverStderr}`);
}
try {
  await waitHealth();
  const redirectUri = "https://chatgpt.com/connector/oauth/spawn-isolation";
  const resource = `${publicOrigin}/mcp`;
  const registration = await jsonFetch(`${origin}/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"], client_name: "spawn-isolation-e2e" }),
  });
  assert.equal(registration.response.status, 201, registration.text);
  const client = registration.body;
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd";
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const authorizationUrl = new URL(`${origin}/authorize`);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", resource, scope: "mcp", state: "spawn-isolation" })) authorizationUrl.searchParams.set(key, value);
  const authorization = await fetch(authorizationUrl, { redirect: "manual", headers: { "tailscale-user-login": "owner@example.com" } });
  assert.equal(authorization.status, 302, await authorization.text());
  const code = new URL(authorization.headers.get("location")).searchParams.get("code");
  assert.ok(code);
  const token = await jsonFetch(`${origin}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: redirectUri, code_verifier: verifier, resource }),
  });
  assert.equal(token.response.status, 200, token.text);
  const auth = `Bearer ${token.body.access_token}`;
  async function mcpPost(sessionId, message) {
    const headers = { authorization: auth, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const result = await jsonFetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
    assert.ok(result.response.ok, `${result.response.status}: ${result.text}`);
    if (typeof result.body === "string" && result.response.headers.get("content-type")?.includes("text/event-stream")) {
      const data = [...result.text.matchAll(/^data:\s*(.+)$/gm)].at(-1)?.[1];
      assert.ok(data, result.text);
      result.body = JSON.parse(data);
    }
    return result;
  }
  const initialized = await mcpPost(undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "spawn-isolation-e2e", version: "1" } } });
  const sessionId = initialized.response.headers.get("mcp-session-id");
  await mcpPost(sessionId, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  const startAt = performance.now();
  const startPromise = mcpPost(sessionId, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "start_process", arguments: { command: "Write-Output E2E_SPAWN_ISOLATION_OK" } } });
  await sleep(100);
  const healthAt = performance.now();
  const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
  const healthMs = performance.now() - healthAt;
  assert.equal(health.status, 200);
  assert.ok(healthMs < 500, `health blocked ${healthMs.toFixed(1)}ms during forced spawn stall`);
  const startResult = await startPromise;
  const startMs = performance.now() - startAt;
  assert.ok(startMs < 1500, `start_process exceeded bounded wait: ${startMs.toFixed(1)}ms`);
  const startPayload = JSON.parse(startResult.body.result.content[0].text);
  assert.ok(startPayload.process_id);
  let final = startPayload;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleep(100);
    const readResult = await mcpPost(sessionId, { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: "read_output", arguments: { process_id: startPayload.process_id, wait_ms: 250 } } });
    final = JSON.parse(readResult.body.result.content[0].text);
    if (final.running === false) break;
  }
  assert.equal(final.running, false, JSON.stringify(final));
  assert.match(final.stdout, /E2E_SPAWN_ISOLATION_OK/);
  assert.ok(Number(final.pid) > 0, JSON.stringify(final));
  console.log(JSON.stringify({ ok: true, health_ms: Number(healthMs.toFixed(1)), start_process_ms: Number(startMs.toFixed(1)), pid: final.pid, exit_code: final.exit_code }));
} finally {
  server.kill();
  await sleep(100);
  rmSync(temporary, { recursive: true, force: true });
}
