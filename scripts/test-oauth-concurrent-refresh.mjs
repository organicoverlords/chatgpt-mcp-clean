import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temp = await mkdtemp(join(tmpdir(), "mcp-oauth-concurrent-"));
const port = await new Promise((resolvePort, reject) => {
  const socket = createServer();
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const port = socket.address().port;
    socket.close((error) => error ? reject(error) : resolvePort(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const publicOrigin = "https://oauth-concurrency.test";
const clientId = "11111111-1111-4111-8111-111111111111";
const refreshToken = randomBytes(32).toString("base64url");
const oauthPath = join(temp, "oauth.json");
const logPath = join(temp, "transport.jsonl");
await writeFile(oauthPath, JSON.stringify({
  clients: { [clientId]: { client_id: clientId, redirect_uris: ["https://chatgpt.com/connector/oauth/concurrency-test"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "test" } },
  access: {}, codes: {},
  refresh: { [createHash("sha256").update(refreshToken).digest("hex")]: { clientId, scopes: ["mcp", "offline_access"], resource: `${publicOrigin}/mcp`, expiresAt: Date.now() + 86400000, subject: "test@example.com" } },
}));
const child = spawn(process.execPath, [resolve("dist/index.js")], {
  cwd: resolve("."), windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
  env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MCP_BACKEND_MODE: "1", MCP_TOOL_PROFILE: "process", MCP_PUBLIC_ORIGIN: publicOrigin,
    MCP_OWNER_AUTH_ORIGIN: "", MCP_OWNER_AUTH_MODE: "local-edge", TAILSCALE_OWNER_LOGIN: "test@example.com", MCP_OAUTH_STORE_PATH: oauthPath,
    MCP_TRANSPORT_LOG_PATH: logPath, MCP_PROCESS_RECEIPT_DIR: join(temp, "receipts"), MCP_RUNTIME_INSTANCE_ID: "", MCP_RUNTIME_SOURCE_COMMIT: "",
    MCP_RUNTIME_DIST_SHA256: "", MCP_RUNTIME_SOURCE_DIRTY: "", MCP_NATIVE_OMEN_HOST: "0", MCP_DEFAULT_EXECUTION_TARGET: "local", MCP_OMEN_MCP_URL: "" },
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
const refresh = async (token) => {
  const response = await fetch(`${origin}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: token, resource: `${publicOrigin}/mcp` }) });
  return { status: response.status, tokens: await response.json() };
};
try {
  let healthy = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { healthy = (await fetch(`${origin}/health`)).ok; if (healthy) break; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.equal(healthy, true, stderr);
  const results = await Promise.all(Array.from({ length: 30 }, () => refresh(refreshToken)));
  assert.ok(results.every((result) => result.status === 200), "all concurrent HTTP refresh requests must succeed");
  assert.equal(new Set(results.map((result) => result.tokens.refresh_token)).size, 1, "all retries must return the same successor");
  const successor = results[0].tokens.refresh_token;
  assert.notEqual(successor, refreshToken);
  const next = await refresh(successor);
  assert.equal(next.status, 200, "delivered successor must remain usable");
  assert.equal((await refresh(refreshToken)).status, 400, "already advanced parent must not mint a stale successor");
  assert.equal((await refresh(next.tokens.refresh_token)).status, 200, "short-window late retry must not revoke the active family");
  const disk = await readFile(oauthPath, "utf8");
  let log = await readFile(logPath, "utf8");
  const logDeadline = Date.now() + 2_000;
  while (!log.includes("successor_already_rotated") && Date.now() < logDeadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
    log = await readFile(logPath, "utf8");
  }
  for (const token of [refreshToken, successor, ...results.map((result) => result.tokens.access_token)]) {
    assert.equal(disk.includes(token), false, "store must contain hashes only");
    assert.equal(log.includes(token), false, "telemetry must not contain tokens");
  }
  assert.ok(log.includes("coalesced_retry"), "successful coalescing must be observable");
  assert.ok(log.includes("successor_already_rotated"), "rejection reason must be observable");
  console.log("PASS oauth_http_concurrent_refresh requests=30 one_successor=true subsequent_refresh=true late_retry_preserves_family=true secrets_not_stored_or_logged=true");
} finally {
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill();
  await exited;
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
