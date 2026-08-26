import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const temporary = mkdtempSync(join(tmpdir(), "shell-mcp-replacement-proof-"));
const configPath = join(temporary, "active-backend.json");
const routesPath = join(temporary, "process-routes.json");
const oauthPath = join(temporary, "oauth.json");
const busyPath = join(temporary, "busy.json");
const receiptPath = join(temporary, "receipts");
const publicOrigin = "https://continuity-proof.ts.net";
const resource = `${publicOrigin}/mcp`;
const owner = "owner@example.com";
const redirectUri = "http://127.0.0.1:54321/callback";
const children = [];
const reservedPorts = new Set();

async function unusedPort() {
  for (;;) {
    const server = createServer();
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = server.address().port;
    await new Promise((resolveClose) => server.close(resolveClose));
    if (!reservedPorts.has(port)) {
      reservedPorts.add(port);
      return port;
    }
  }
}
async function waitHealth(origin, predicate) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`${origin}/health`);
      const body = await response.json();
      if (response.ok && predicate(body)) return body;
    } catch {}
    await sleep(25);
  }
  throw new Error(`health timeout: ${origin}`);
}
function launch(script, env) {
  const child = spawn(process.execPath, [resolve(script)], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stderrText = "";
  child.stderr.on("data", (chunk) => { child.stderrText += chunk.toString(); });
  children.push(child);
  return child;
}
function writeTarget(port, generation) {
  writeFileSync(configPath, `${JSON.stringify({ version: 1, port, generation }, null, 2)}\n`, "utf8");
}
async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body, text };
}
function rpcPayload(result) {
  assert.ok(result.body?.result, result.text);
  const text = result.body.result.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : result.body.result;
}

let monitor = false;
let monitorPromise;
try {
  const bluePort = await unusedPort();
  const greenPort = await unusedPort();
  const frontDoorPort = await unusedPort();
  const frontDoorHost = `127.0.0.1:${frontDoorPort}`;
  const commonBackendEnv = {
    MCP_BACKEND_MODE: "1",
    MCP_FRONT_DOOR_HOST: frontDoorHost,
    MCP_PUBLIC_ORIGIN: publicOrigin,
    TAILSCALE_OWNER_LOGIN: owner,
    MCP_OAUTH_STORE_PATH: oauthPath,
    MCP_BUSY_STORE_PATH: busyPath,
    MCP_PROCESS_RECEIPT_DIR: receiptPath,
  };
  const blue = launch("dist/index.js", { ...commonBackendEnv, PORT: String(bluePort), MCP_TRANSPORT_LOG_PATH: join(temporary, "blue-transport.jsonl") });
  const green = launch("dist/index.js", { ...commonBackendEnv, PORT: String(greenPort), MCP_TRANSPORT_LOG_PATH: join(temporary, "green-transport.jsonl") });
  const blueHealth = await waitHealth(`http://127.0.0.1:${bluePort}`, (body) => body.role === "backend" && body.port === bluePort);
  await waitHealth(`http://127.0.0.1:${greenPort}`, (body) => body.role === "backend" && body.port === greenPort);
  writeTarget(bluePort, blueHealth.backend_generation);
  const frontDoor = launch("dist/front-door.js", { FRONT_DOOR_PORT: String(frontDoorPort), MCP_BACKEND_CONFIG_PATH: configPath, MCP_PROCESS_ROUTE_PATH: routesPath });
  const frontDoorOrigin = `http://127.0.0.1:${frontDoorPort}`;
  const firstHealth = await waitHealth(frontDoorOrigin, (body) => body.name === "shell-mcp" && body.port === frontDoorPort);

  const registration = await jsonFetch(`${frontDoorOrigin}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "restart-proof" }),
  });
  assert.equal(registration.response.status, 201, registration.text);
  const client = registration.body;
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizationUrl = new URL(`${frontDoorOrigin}/authorize`);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", resource, scope: "mcp offline_access", state: "proof" })) authorizationUrl.searchParams.set(key, value);
  const authorization = await fetch(authorizationUrl, { redirect: "manual", headers: { "tailscale-user-login": owner } });
  assert.equal(authorization.status, 302, await authorization.text());
  const code = new URL(authorization.headers.get("location")).searchParams.get("code");
  const token = await jsonFetch(`${frontDoorOrigin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: redirectUri, code_verifier: verifier, resource }),
  });
  assert.equal(token.response.status, 200, token.text);
  const auth = `Bearer ${token.body.access_token}`;
  const rpc = async (message) => jsonFetch(`${frontDoorOrigin}/mcp`, { method: "POST", headers: { authorization: auth, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify(message) });
  const call = async (name, args) => rpcPayload(await rpc({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }));

  const before = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const beforeTools = before.body.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(beforeTools, ["busy_claim", "busy_list", "busy_release", "kill_process", "read_output", "start_process", "view_image"]);
  assert.equal(before.response.headers.has("x-shell-mcp-front-door"), false, "front door must not inject worker-visible response metadata");
  const claim = await call("busy_claim", { actor: "continuity-proof", scope: "offpath:backend-replacement" });
  assert.equal(claim.ok, true);
  const started = await call("start_process", { command: "Write-Output 'BLUE_PROCESS'; Start-Sleep -Seconds 20" });
  assert.ok(started.process_id && started.running);

  const healthFailures = [];
  monitor = true;
  monitorPromise = (async () => {
    while (monitor) {
      try {
        const response = await fetch(`${frontDoorOrigin}/health`, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok || body.pid !== firstHealth.pid) healthFailures.push(`status=${response.status}`);
      } catch (error) { healthFailures.push(error.message); }
      await sleep(10);
    }
  })();

  const switchOutput = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve("scripts/switch-backend.ps1"), "-CandidatePort", String(greenPort), "-FrontDoorOrigin", frontDoorOrigin, "-BackendConfigPath", configPath, "-HealthSamples", "40", "-TestMode"], { encoding: "utf8" }).trim();
  const switchReceipt = JSON.parse(switchOutput.replace(/^\uFEFF/, ""));
  assert.equal(switchReceipt.status, "PROVEN");
  assert.equal(switchReceipt.health_failures, 0);
  const after = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const afterTools = after.body.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(afterTools, beforeTools, "worker-visible tool surface changed across backend replacement");
  const claims = await call("busy_list", {});
  assert.ok(claims.claims.some((item) => item.actor === "continuity-proof" && item.scope === "offpath:backend-replacement"), "BUSY claim did not survive backend replacement");
  let output;
  for (let attempt = 0; attempt < 10; attempt++) {
    output = await call("read_output", { process_id: started.process_id, wait_ms: 500 });
    if (/BLUE_PROCESS/.test(output.stdout || "")) break;
  }
  assert.equal(output.process_id, started.process_id);
  assert.match(output.stdout, /BLUE_PROCESS/);
  assert.equal(output.running, true, "same process_id was not routed to the draining backend");
  const killed = await call("kill_process", { process_id: started.process_id });
  assert.equal(killed.killed, true);
  const released = await call("busy_release", { actor: "continuity-proof", scope: "offpath:backend-replacement" });
  assert.equal(released.ok, true);
  const refreshed = await jsonFetch(`${frontDoorOrigin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: token.body.refresh_token, resource, scope: "mcp offline_access" }),
  });
  assert.equal(refreshed.response.status, 200, `OAuth store did not survive backend replacement: ${refreshed.text}`);

  blue.kill();
  await sleep(250);
  monitor = false;
  await monitorPromise;
  assert.deepEqual(healthFailures, [], `front-door health disappeared: ${healthFailures.join("; ")}`);
  assert.equal(frontDoor.exitCode, null, frontDoor.stderrText);
  assert.equal(green.exitCode, null, green.stderrText);
  console.log(`PASS offpath_backend_replacement front_door_pid=${firstHealth.pid} health_failures=0 tools_unchanged=true oauth_preserved=true busy_preserved=true process_id_preserved=true blue_port=${bluePort} green_port=${greenPort}`);
} finally {
  monitor = false;
  if (monitorPromise) await monitorPromise.catch(() => undefined);
  for (const child of children) if (child.exitCode === null) child.kill();
  await sleep(150);
  rmSync(temporary, { recursive: true, force: true });
}
