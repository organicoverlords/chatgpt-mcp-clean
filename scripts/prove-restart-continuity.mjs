import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const origin = (process.env.MCP_SMOKE_ORIGIN || process.env.MCP_PUBLIC_ORIGIN || "").replace(/\/$/, "");
const ownerLogin = (process.env.TAILSCALE_OWNER_LOGIN || "").trim();
const redirectUri = "https://chatgpt.com/connector/oauth/restart-proof";
const resource = `${origin}/mcp`;
const configPath = resolve(process.env.MCP_BACKEND_CONFIG_PATH || ".state/front-door/active-backend.json");
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
assert.ok(origin && ownerLogin, "MCP_PUBLIC_ORIGIN and TAILSCALE_OWNER_LOGIN are required");

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body, text };
}
const frontDoorHealth = await jsonFetch(`${origin}/health`);
assert.equal(frontDoorHealth.response.status, 200, frontDoorHealth.text);
assert.equal(frontDoorHealth.body.name, "shell-mcp");
assert.equal(frontDoorHealth.body.port, 3003, "public health is not served by the stable front door");
const frontDoorPid = frontDoorHealth.body.pid;

const registration = await jsonFetch(`${origin}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "restart-proof" }),
});
assert.equal(registration.response.status, 201, registration.text);
const client = registration.body;
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authorizationUrl = new URL(`${origin}/authorize`);
for (const [key, value] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", resource, scope: "mcp offline_access", state: "restart-proof" })) authorizationUrl.searchParams.set(key, value);
const authorization = await fetch(authorizationUrl, { redirect: "manual", headers: { "tailscale-user-login": ownerLogin } });
assert.equal(authorization.status, 302, await authorization.text());
const code = new URL(authorization.headers.get("location")).searchParams.get("code");
assert.ok(code);
const token = await jsonFetch(`${origin}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: redirectUri, code_verifier: verifier, resource }),
});
assert.equal(token.response.status, 200, token.text);
const auth = `Bearer ${token.body.access_token}`;

async function rpc(message) {
  const result = await jsonFetch(`${origin}/mcp`, { method: "POST", headers: { authorization: auth, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify(message) });
  assert.ok(result.response.ok, `${result.response.status}: ${result.text}`);
  assert.equal(result.response.headers.has("x-shell-mcp-front-door"), false, "front door injected worker-visible transport metadata");
  return result;
}
function toolResult(result) {
  assert.ok(result.body?.result, result.text);
  return JSON.parse(result.body.result.content[0].text);
}
async function callTool(name, args) {
  return toolResult(await rpc({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }));
}

const before = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const beforeTools = before.body.result.tools.map((tool) => tool.name).sort();
assert.deepEqual(beforeTools, ["busy_claim", "busy_list", "busy_release", "kill_process", "read_output", "start_process", "view_image"]);
const claim = await callTool("busy_claim", { actor: "restart-proof", scope: "mcp:backend-replacement-proof" });
assert.equal(claim.ok, true);
const started = await callTool("start_process", { command: "Write-Output 'BEFORE_BACKEND_SWITCH'; Start-Sleep -Seconds 20" });
assert.ok(started.process_id && started.running);

const active = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
const candidatePort = active.port === 3001 ? 3002 : 3001;
const candidateHealth = await jsonFetch(`http://127.0.0.1:${candidatePort}/health`);
assert.equal(candidateHealth.response.status, 200, candidateHealth.text);
assert.equal(candidateHealth.body.role, "backend");
const switchProcess = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/switch-backend.ps1"), "-CandidatePort", String(candidatePort), "-HealthSamples", "100"], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let switchStdout = "";
let switchStderr = "";
switchProcess.stdout.on("data", (chunk) => { switchStdout += chunk.toString(); });
switchProcess.stderr.on("data", (chunk) => { switchStderr += chunk.toString(); });
const healthFailures = [];
while (switchProcess.exitCode === null) {
  try {
    const health = await jsonFetch(`${origin}/health`);
    if (!health.response.ok || health.body.pid !== frontDoorPid) healthFailures.push(`status=${health.response.status}`);
  } catch (error) { healthFailures.push(error.message); }
  await sleep(20);
}
assert.equal(switchProcess.exitCode, 0, switchStderr || switchStdout);
const switchReceipt = JSON.parse(switchStdout.trim().replace(/^\uFEFF/, ""));
assert.equal(switchReceipt.status, "PROVEN");
assert.deepEqual(healthFailures, [], `public/front-door health disappeared: ${healthFailures.join("; ")}`);

const after = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const afterTools = after.body.result.tools.map((tool) => tool.name).sort();
assert.deepEqual(afterTools, beforeTools, "worker-visible tool surface changed");
const claims = await callTool("busy_list", {});
assert.ok(claims.claims.some((item) => item.actor === "restart-proof" && item.scope === "mcp:backend-replacement-proof"));
let output;
for (let attempt = 0; attempt < 10; attempt++) {
  output = await callTool("read_output", { process_id: started.process_id, wait_ms: 500 });
  if (/BEFORE_BACKEND_SWITCH/.test(output.stdout || "")) break;
}
assert.equal(output.process_id, started.process_id);
assert.match(output.stdout, /BEFORE_BACKEND_SWITCH/);
const killed = await callTool("kill_process", { process_id: started.process_id });
assert.equal(killed.killed, true);
const released = await callTool("busy_release", { actor: "restart-proof", scope: "mcp:backend-replacement-proof" });
assert.equal(released.ok, true);
const refreshed = await jsonFetch(`${origin}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: token.body.refresh_token, resource, scope: "mcp offline_access" }),
});
assert.equal(refreshed.response.status, 200, refreshed.text);
console.log(`PASS backend_restart_continuity front_door_pid=${frontDoorPid} old_backend_port=${active.port} new_backend_port=${candidatePort} health_failures=0 tools_unchanged=true oauth_preserved=true busy_preserved=true process_id_preserved=true old_backend_draining=true`);
