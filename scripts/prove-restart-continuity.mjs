import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const origin = (process.env.MCP_SMOKE_ORIGIN || process.env.MCP_PUBLIC_ORIGIN || "").replace(/\/$/, "");
const ownerLogin = (process.env.TAILSCALE_OWNER_LOGIN || "").trim();
const redirectUri = "https://chatgpt.com/connector/oauth/restart-proof";
const resource = `${origin}/mcp`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
assert.ok(origin && ownerLogin, "MCP_PUBLIC_ORIGIN and TAILSCALE_OWNER_LOGIN are required");

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body, text };
}
const registration = await jsonFetch(`${origin}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "restart-proof" }),
});
assert.equal(registration.response.status, 201, registration.text);
const client = registration.body;
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd";
const challenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
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

async function rpc(message, sessionId) {
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
function toolResult(result) {
  assert.ok(result.body?.result, result.text);
  return JSON.parse(result.body.result.content[0].text);
}
async function callTool(name, args, sessionId) {
  return toolResult(await rpc({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }, sessionId));
}

const initialized = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "restart-proof", version: "1.0.0" } } });
const sessionId = initialized.response.headers.get("mcp-session-id") || undefined;
await rpc({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sessionId);
const before = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
const beforeTools = before.body.result.tools.map((tool) => tool.name).sort();
assert.deepEqual(beforeTools, ["busy_claim", "busy_list", "busy_release", "kill_process", "read_output", "start_process", "view_image"]);

const pidText = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$c=Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){$c.OwningProcess}"], { encoding: "utf8" }).trim();
const oldPid = Number(pidText);
assert.ok(oldPid > 0, "no MCP listener to restart");
const processInfo = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$n=Get-CimInstance Win32_Process -Filter 'ProcessId=${oldPid}'; $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$($n.ParentProcessId)\"; [pscustomobject]@{command=$n.CommandLine;parent=$p.CommandLine} | ConvertTo-Json -Compress`], { encoding: "utf8" }));
assert.match(processInfo.command || "", /dist[\\/]index\.js/i, processInfo.command);
assert.match(processInfo.parent || "", /ChatGPTMcpClean[\\/]start\.ps1/i, processInfo.parent);
execFileSync("taskkill.exe", ["/PID", String(oldPid), "/T", "/F"], { encoding: "utf8" });

let newPid = 0;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  try {
    const health = await jsonFetch(`${origin}/health`);
    if (health.response.ok && health.body?.status === "ok") {
      const pid = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$c=Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){$c.OwningProcess}"], { encoding: "utf8" }).trim();
      newPid = Number(pid);
      if (newPid && newPid !== oldPid) break;
    }
  } catch {}
}
assert.ok(newPid && newPid !== oldPid, `supervisor did not replace PID ${oldPid}`);

const staleHeader = "restart-proof-stale-session";
const after = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, staleHeader);
const afterTools = after.body.result.tools.map((tool) => tool.name).sort();
assert.deepEqual(afterTools, beforeTools);
const started = await callTool("start_process", { command: "Write-Output 'AFTER_RESTART'; Start-Sleep -Seconds 20" }, staleHeader);
assert.ok(started.process_id && started.running);
await sleep(500);
const output = await callTool("read_output", { process_id: started.process_id }, staleHeader);
assert.match(output.stdout, /AFTER_RESTART/);
const killed = await callTool("kill_process", { process_id: started.process_id }, staleHeader);
assert.equal(killed.killed, true);
console.log(`PASS controlled_restart old_pid=${oldPid} new_pid=${newPid} session_id_header=${sessionId ? "present-before-restart" : "none-stateless"} stale_header_reused=true tools=${afterTools.join(",")} post_restart=start_process+read_output+kill_process`);
