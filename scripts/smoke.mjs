import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const origin = (process.env.MCP_SMOKE_ORIGIN || process.env.MCP_PUBLIC_ORIGIN || "http://127.0.0.1:3000").replace(/\/$/, "");
const publicOrigin = (process.env.MCP_SMOKE_PUBLIC_ORIGIN || origin).replace(/\/$/, "");
const ownerLogin = (process.env.TAILSCALE_OWNER_LOGIN || "owner@example.com").trim();
const redirectUri = "https://chatgpt.com/connector/oauth/smoke";
const resource = `${publicOrigin}/mcp`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toolProfile = (process.env.MCP_TOOL_PROFILE || "process").trim().toLowerCase();
const expectedTools = toolProfile === "process"
  ? ["kill_process", "read_output", "start_process"]
  : ["busy_claim", "busy_list", "busy_release", "kill_process", "read_output", "start_process", "view_image"];

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
  body: JSON.stringify({
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "shell-mcp-smoke",
  }),
});
assert.equal(registration.response.status, 201, registration.text);
assert.equal(registration.response.headers.get("ratelimit-policy"), "300;w=3600");
const client = registration.body;
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd";
const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
const authorizationUrl = new URL(`${origin}/authorize`);
for (const [key, value] of Object.entries({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: redirectUri,
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource,
  scope: "mcp offline_access",
  state: "shell-mcp-smoke",
})) authorizationUrl.searchParams.set(key, value);
const authorization = await fetch(authorizationUrl, { redirect: "manual", headers: { "tailscale-user-login": ownerLogin } });
assert.equal(authorization.status, 302, await authorization.text());
const code = new URL(authorization.headers.get("location")).searchParams.get("code");
assert.ok(code);

const token = await jsonFetch(`${origin}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource,
  }),
});
assert.equal(token.response.status, 200, token.text);
const accessToken = token.body.access_token;
const refreshToken = token.body.refresh_token;
assert.ok(accessToken && refreshToken);
for (let i = 0; i < 2; i++) {
  const refreshed = await jsonFetch(`${origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: refreshToken, resource, scope: "mcp offline_access" }),
  });
  assert.equal(refreshed.response.status, 200, refreshed.text);
}

const auth = `Bearer ${accessToken}`;
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
async function initialize() {
  const result = await mcpPost(undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shell-mcp-smoke", version: "1.0.0" } } });
  const sessionId = result.response.headers.get("mcp-session-id") || undefined;
  await mcpPost(sessionId, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  return sessionId;
}
function toolResult(result) {
  assert.ok(result.body?.result, result.text);
  const content = result.body.result.content;
  assert.ok(Array.isArray(content) && content[0]?.text, result.text);
  return JSON.parse(content[0].text);
}
async function callTool(sessionId, name, args = {}) {
  return toolResult(await mcpPost(sessionId, { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }));
}
async function waitForOutput(sessionId, processId, pattern, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let output;
  do {
    output = await callTool(sessionId, "read_output", { process_id: processId });
    if (pattern.test(output.stdout)) return output;
    await sleep(100);
  } while (Date.now() < deadline);
  return output;
}
async function readAllUntilExit(sessionId, first, timeoutMs = 20_000) {
  const processId = first.process_id;
  const deadline = Date.now() + timeoutMs;
  const pages = [];
  let stdout = "";
  let stderr = "";
  let output = first;
  do {
    if (output.output_page) {
      assert.equal(output.output_page.stdout_start, stdout.length, "stdout pages remain contiguous");
      assert.equal(output.output_page.stderr_start, stderr.length, "stderr pages remain contiguous");
      stdout += output.stdout || "";
      stderr += output.stderr || "";
      pages.push(output);
    } else if (!output.running) {
      stdout = output.stdout || "";
      stderr = output.stderr || "";
      pages.push(output);
    }
    if (!output.running && output.next_action !== "READ_SAME_PROCESS_ID") {
      return { pages, stdout, stderr, last: output };
    }
    output = await callTool(sessionId, "read_output", { process_id: processId, max_chars: 32_000 });
  } while (Date.now() < deadline);
  throw new Error(`process ${processId} did not reach a terminal output page within ${timeoutMs}ms`);
}

const sessionA = await initialize();
const getController = new AbortController();
const standaloneGet = await fetch(`${origin}/mcp`, {
  method: "GET",
  headers: { authorization: auth, accept: "text/event-stream", "mcp-protocol-version": "2025-06-18" },
  signal: getController.signal,
});
// Server is stateless POST-only (sessionIdGenerator: undefined); GET/SSE is optional in
// MCP Streamable HTTP. Contract is 405 + Allow: POST, asserted here so a regression to a
// silent 200/500 is caught.
if (standaloneGet.status !== 405) throw new Error(`GET /mcp expected 405, got ${standaloneGet.status} ${await standaloneGet.text()}`);
assert.equal(standaloneGet.headers.get("allow"), "POST");
getController.abort();
const listed = await mcpPost(sessionA, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const names = listed.body.result.tools.map((tool) => tool.name).sort();
assert.deepEqual(names, expectedTools);
const startProcessTool = listed.body.result.tools.find((tool) => tool.name === "start_process");
assert.equal(startProcessTool.inputSchema.properties.wait_ms.maximum, 10_000);
assert.equal(startProcessTool.inputSchema.properties.wait_ms.minimum, 0);
const readOutputTool = listed.body.result.tools.find((tool) => tool.name === "read_output");
assert.equal(readOutputTool.inputSchema.properties.wait_ms.maximum, 10_000);
assert.equal(readOutputTool.inputSchema.properties.wait_ms.minimum, 0);

const startedAt = Date.now();
let jobOne;
let jobTwo;
let treeJob;
let floodJob;
try {
  jobOne = await callTool(sessionA, "start_process", { command: "1..20 | ForEach-Object { Write-Output ('JOB_ONE_' + $_); Start-Sleep -Milliseconds 200 }" });
  assert.ok(jobOne.process_id && Date.now() - startedAt < 5000);
  assert.equal(jobOne.running, true);
  const outputOne = await waitForOutput(sessionA, jobOne.process_id, /JOB_ONE_/);
  assert.equal(outputOne.running, true);
  assert.match(outputOne.stdout, /JOB_ONE_/, JSON.stringify({
    running: outputOne.running,
    exit_code: outputOne.exit_code,
    signal: outputOne.signal,
    stderr: outputOne.stderr,
    error: outputOne.error,
  }));

  jobTwo = await callTool(sessionA, "start_process", { command: "1..20 | ForEach-Object { Write-Output ('JOB_TWO_' + $_); Start-Sleep -Milliseconds 200 }" });
  assert.ok(jobTwo.process_id && jobTwo.process_id !== jobOne.process_id);
  const [readOne, readTwo] = await Promise.all([
    callTool(sessionA, "read_output", { process_id: jobOne.process_id }),
    callTool(sessionA, "read_output", { process_id: jobTwo.process_id }),
  ]);
  assert.equal(readOne.running, true);
  assert.equal(readTwo.running, true);

  treeJob = await callTool(sessionA, "start_process", { command: "$child = Start-Process -FilePath \"$env:SystemRoot\\System32\\ping.exe\" -ArgumentList @('-t','127.0.0.1') -WindowStyle Hidden -PassThru; Write-Output ('CHILD_PID=' + $child.Id); Wait-Process -Id $child.Id" });
  const treeOutput = await waitForOutput(sessionA, treeJob.process_id, /CHILD_PID=(\d+)/);
  const childPid = Number(treeOutput.stdout.match(/CHILD_PID=(\d+)/)?.[1]);
  assert.ok(childPid > 0, treeOutput.stdout);
  const killed = await callTool(sessionA, "kill_process", { process_id: treeJob.process_id });
  assert.equal(killed.killed, true);
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `if (Get-Process -Id ${childPid} -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }`], { encoding: "utf8" });

  floodJob = await callTool(sessionA, "start_process", { command: "$payload = 'X' * 200; 1..10000 | ForEach-Object { Write-Output (('FLOOD_{0}_{1}' -f $_,$payload)) }" });
  const healthStarted = Date.now();
  const healthDuringFlood = await jsonFetch(`${origin}/health`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(healthDuringFlood.response.status, 200, healthDuringFlood.text);
  assert.ok(Date.now() - healthStarted < 5_000, "health probe stalled during high-output process");
  const floodOutput = await readAllUntilExit(sessionA, floodJob);
  assert.equal(floodOutput.last.running, false);
  assert.ok(floodOutput.pages[0].stdout.length > 30_000 && floodOutput.pages[0].stdout.length <= 32_000, `first paged read_output returned ${floodOutput.pages[0].stdout.length} characters`);
  assert.equal(floodOutput.pages.at(-1).stdout_truncated, true);
  assert.equal(floodOutput.stdout.length, 100_000, `lossless retained output returned ${floodOutput.stdout.length} characters`);
  assert.match(floodOutput.stdout, /FLOOD_10000_/);

  if (toolProfile === "full") {
  const sessionB = await initialize();
  const scope = `smoke-exact-scope-${Date.now()}`;
  const claimA = await callTool(sessionA, "busy_claim", { actor: "smoke-actor-a", scope });
  assert.equal(claimA.ok, true);
  const claimB = await callTool(sessionB, "busy_claim", { actor: "smoke-actor-b", scope });
  assert.equal(claimB.ok, false);
  assert.equal(claimB.reason, "scope_already_claimed");
  const listedBusy = await callTool(sessionB, "busy_list");
  assert.ok(listedBusy.claims.some((claim) => claim.actor === "smoke-actor-a" && claim.scope === scope));
  const wrongRelease = await callTool(sessionB, "busy_release", { actor: "smoke-actor-b", scope });
  assert.equal(wrongRelease.ok, false);
  const released = await callTool(sessionA, "busy_release", { actor: "smoke-actor-a", scope });
  assert.equal(released.ok, true);
  const afterRelease = await callTool(sessionB, "busy_list");
  assert.ok(!afterRelease.claims.some((claim) => claim.scope === scope));
  }
} finally {
  if (jobOne?.process_id) await callTool(sessionA, "kill_process", { process_id: jobOne.process_id }).catch(() => undefined);
  if (jobTwo?.process_id) await callTool(sessionA, "kill_process", { process_id: jobTwo.process_id }).catch(() => undefined);
  if (treeJob?.process_id) await callTool(sessionA, "kill_process", { process_id: treeJob.process_id }).catch(() => undefined);
  if (floodJob?.process_id) await callTool(sessionA, "kill_process", { process_id: floodJob.process_id }).catch(() => undefined);
}

const smokePort = Number(new URL(origin).port || (new URL(origin).protocol === "https:" ? 443 : 80));
const listenerJson = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-NetTCPConnection -LocalPort ${smokePort} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`], { encoding: "utf8" }).trim();
assert.ok(listenerJson, `smoke origin port ${smokePort} has no listener`);
const port9121 = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "if (Get-NetTCPConnection -LocalPort 9121 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"], { encoding: "utf8" });
assert.equal(port9121, "");
const processJson = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8" });
const processes = JSON.parse(processJson);
const processList = Array.isArray(processes) ? processes : [processes];
const hasSerenaProcess = processList.some((process) => {
  const name = String(process.Name || "").toLowerCase();
  const commandLine = String(process.CommandLine || "");
  const directBinary = /^serena(?:\.exe)?$/.test(name);
  const launcher = /^(?:uvx?|python(?:3)?)(?:\.exe)?$/.test(name);
  return directBinary || (launcher && /\bserena\b/i.test(commandLine) && /\bstart-mcp-server\b/i.test(commandLine));
});
assert.ok(!hasSerenaProcess, "Serena process exists");
const busySmoke = toolProfile === "full" ? "cross_session_claim_list_release" : "outside_process_profile";
console.log(`PASS mcp=standard-initialize tools=${names.join(",")} background=immediate+read_while_running concurrency=two_jobs high_output=bounded+health-responsive kill_tree=root+child_gone busy=${busySmoke} listener=${listenerJson} port9121=unused serena=absent`);
