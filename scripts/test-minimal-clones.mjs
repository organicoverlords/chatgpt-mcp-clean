import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const externalStateRoot = process.env.MCP_TEST_STATE_ROOT?.trim();
if (externalStateRoot) mkdirSync(resolve(externalStateRoot), { recursive: true });
const temporary = mkdtempSync(externalStateRoot
  ? join(resolve(externalStateRoot), "mcp-minimal-clones-")
  : join(tmpdir(), "mcp-minimal-clones-"));
const sharedReceipts = join(temporary, "shared-process-receipts");
mkdirSync(sharedReceipts, { recursive: true });
const bootstrapSnapshot = join(temporary, "bootstrap.json");
writeFileSync(bootstrapSnapshot, JSON.stringify({
  bootstrap_warning: "TEST_BOOTSTRAP_INTEGRITY", schema: "bootstrap.v1", generated_at: new Date().toISOString(),
  nonce: crypto.randomUUID(), bootstrap_end: { status: "COMPLETE", schema: "bootstrap.v1" }, marker: "AUTHENTICATED_SNAPSHOT",
}), "utf8");
const children = [];
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function unusedPort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitHealth(origin, expectedPort, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.status === "ok" && body.name === "shell-mcp" && body.port === expectedPort) return body;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error(`health timeout: ${origin}`);
}

function startClone(id, port, extraEnv = {}) {
  const state = join(temporary, id);
  mkdirSync(state, { recursive: true });
  const publicOrigin = id === "clone-a" ? `https://${id}.test.ts.net/clone-a` : "https://5-61-91-127.sslip.io";
  const child = spawn(process.execPath, [resolve("dist/index.js")], {
    cwd: resolve("."),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      MCP_BACKEND_MODE: "1",
      MCP_TOOL_PROFILE: "process",
      MCP_VISUAL_PROOF_UI: "0",
      MCP_VISUAL_PROOF_REVIEW: "0",
      MCP_PUBLIC_ORIGIN: publicOrigin,
      MCP_OWNER_AUTH_ORIGIN: "",
      MCP_OWNER_AUTH_MODE: "tailscale",
      TAILSCALE_OWNER_LOGIN: "owner@example.com",
      MCP_OAUTH_STORE_PATH: join(state, "oauth.json"),
      MCP_TRANSPORT_LOG_PATH: join(state, "transport.jsonl"),
      MCP_PROCESS_RECEIPT_DIR: sharedReceipts,
      MCP_BOOTSTRAP_SNAPSHOT_PATH: bootstrapSnapshot,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  children.push(child);
  return { id, port, publicOrigin, origin: `http://127.0.0.1:${port}`, child, stderr: () => stderr };
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, text, body };
}

async function connect(clone, clientName) {
  const redirectUri = `https://chatgpt.com/connector/oauth/${clientName}`;
  const resource = `${clone.publicOrigin}/mcp`;
  const registration = await jsonFetch(`${clone.origin}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: clientName,
    }),
  });
  assert.equal(registration.response.status, 201, registration.text);
  const client = registration.body;
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd";
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const authorize = new URL(`${clone.origin}/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    scope: "mcp offline_access",
    state: clientName,
  })) authorize.searchParams.set(key, value);
  for (const headers of [
    {},
    { "tailscale-user-login": "   " },
    { "tailscale-user-login": "not-owner@example.com" },
    { "tailscale-user-login": "owner@example.com", "tailscale-funnel-request": "1" },
  ]) {
    const denied = await fetch(authorize, { redirect: "manual", headers });
    assert.equal(denied.status, 403, `expected untrusted authorization context to be denied, got ${denied.status}`);
    assert.equal(await denied.text(), "Owner authorization required");
  }
  const authorization = await fetch(authorize, { redirect: "manual", headers: { "tailscale-user-login": "owner@example.com" } });
  assert.equal(authorization.status, 302, await authorization.text());
  const code = new URL(authorization.headers.get("location")).searchParams.get("code");
  assert.ok(code);
  const token = await jsonFetch(`${clone.origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: redirectUri, code_verifier: verifier, resource }),
  });
  assert.equal(token.response.status, 200, token.text);
  const auth = `Bearer ${token.body.access_token}`;
  async function post(message, sessionId) {
    const headers = { authorization: auth, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "x-openai-session": clientName };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const result = await jsonFetch(`${clone.origin}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
    assert.ok(result.response.ok, `${result.response.status}: ${result.text}`);
    return result;
  }
  const initialized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1" } } });
  const sessionId = initialized.response.headers.get("mcp-session-id") || undefined;
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sessionId);
  async function tools() {
    const result = await post({ jsonrpc: "2.0", id: Date.now(), method: "tools/list", params: {} }, sessionId);
    return result.body.result.tools;
  }
  async function call(name, args = {}) {
    const result = await post({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }, sessionId);
    const text = result.body.result.content?.[0]?.text;
    assert.ok(text, result.text);
    return JSON.parse(text);
  }
  return { tools, call };
}

let cloneA;
let cloneB;
try {
  const portA = await unusedPort();
  const portB = await unusedPort();
  cloneA = startClone("clone-a", portA, { MCP_FORCE_CONNECTION_CLOSE: "1" });
  cloneB = startClone("clone-b", portB);
  await Promise.all([waitHealth(cloneA.origin, portA), waitHealth(cloneB.origin, portB)]);
  const aHealth = await jsonFetch(`${cloneA.origin}/health`);
  assert.equal(aHealth.response.headers.get("connection"), "close", "opt-in clone must close each HTTP response connection");
  assert.equal(aHealth.body.force_connection_close, true);

  const aMetadata = await jsonFetch(`${cloneA.origin}/.well-known/oauth-authorization-server/clone-a`);
  assert.equal(aMetadata.response.status, 200, aMetadata.text);
  assert.equal(aMetadata.body.issuer, "https://clone-a.test.ts.net/clone-a/");
  assert.equal(aMetadata.body.authorization_endpoint, "https://clone-a.test.ts.net/clone-a/authorize");
  assert.equal(aMetadata.body.token_endpoint, "https://clone-a.test.ts.net/clone-a/token");
  assert.equal(aMetadata.body.registration_endpoint, "https://clone-a.test.ts.net/clone-a/register");
  const aProtected = await jsonFetch(`${cloneA.origin}/.well-known/oauth-protected-resource/clone-a/mcp`);
  assert.equal(aProtected.response.status, 200, aProtected.text);
  assert.equal(aProtected.body.resource, "https://clone-a.test.ts.net/clone-a/mcp");
  assert.deepEqual(aProtected.body.authorization_servers, ["https://clone-a.test.ts.net/clone-a/"]);

  const [a1, a2, b1, b2] = await Promise.all([
    connect(cloneA, "clone-a-client-1"),
    connect(cloneA, "clone-a-client-2"),
    connect(cloneB, "clone-b-client-1"),
    connect(cloneB, "clone-b-client-2"),
  ]);
  const expected = ["kill_process", "read_output", "start_process"];
  for (const client of [a1, a2, b1, b2]) {
    const tools = await client.tools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, expected);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(byName.start_process.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    assert.deepEqual(byName.read_output.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    assert.deepEqual(byName.kill_process.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  }

  const bootstrapReads = await Promise.all(["bootstrap", "231b7e74-4cc8-43d0-9702-fd6dfa2215b3", "checkup"].map((process_id) =>
    a1.call("read_output", { process_id, max_chars: 32_000, wait_ms: 0 })));
  for (const snapshot of bootstrapReads) {
    assert.equal(snapshot.process_state, "SNAPSHOT");
    assert.equal(snapshot.next_action, "STOP_READING");
    assert.equal(snapshot.running, false);
    assert.equal(snapshot.snapshot_alias, true);
    const payload = JSON.parse(snapshot.stdout);
    assert.equal(payload.marker, "AUTHENTICATED_SNAPSHOT");
    assert.equal(payload.bootstrap_end?.status, "COMPLETE");
  }
  assert.equal(new Set(bootstrapReads.map((snapshot) => snapshot.stdout)).size, 1, "materialized aliases must share one producer snapshot");

  const started = await a1.call("start_process", { command: "Write-Output 'CLONE_MULTI_CLIENT'; Start-Sleep -Milliseconds 600; Write-Output 'DONE'" });
  assert.ok(started.process_id);
  let seenByOtherClient;
  for (let i = 0; i < 10; i++) {
    seenByOtherClient = await a2.call("read_output", { process_id: started.process_id, wait_ms: 1_000 });
    if (/CLONE_MULTI_CLIENT/.test(seenByOtherClient.stdout)) break;
    assert.equal(seenByOtherClient.running, true, JSON.stringify(seenByOtherClient));
    await sleep(100);
  }
  assert.match(seenByOtherClient.stdout, /CLONE_MULTI_CLIENT/);
  assert.notEqual(seenByOtherClient.caller_id, started.caller_id, "distinct GPT connections must remain distinct callers while sharing process access");

  let completed = seenByOtherClient;
  for (let i = 0; i < 30 && completed.running; i++) {
    await sleep(100);
    completed = await a2.call("read_output", { process_id: started.process_id });
  }
  assert.equal(completed.running, false, JSON.stringify(completed));
  assert.match(completed.stdout, /DONE/);

  const handedOff = await b1.call("read_output", { process_id: started.process_id });
  assert.equal(handedOff.running, false);
  assert.match(handedOff.stdout, /DONE/);

  const liveStarted = await a1.call("start_process", {
    command: "Start-Sleep -Milliseconds 300; Write-Output 'CLONE_LIVE_HANDOFF'; Start-Sleep -Seconds 10",
  });
  let liveSeenFromB;
  for (let i = 0; i < 10; i++) {
    liveSeenFromB = await b1.call("read_output", { process_id: liveStarted.process_id, wait_ms: 1_000 });
    if (/CLONE_LIVE_HANDOFF/.test(liveSeenFromB.stdout)) break;
    assert.equal(liveSeenFromB.running, true, JSON.stringify(liveSeenFromB));
    await sleep(100);
  }
  assert.equal(liveSeenFromB.running, true, JSON.stringify(liveSeenFromB));
  assert.match(liveSeenFromB.stdout, /CLONE_LIVE_HANDOFF/);
  const killedFromB = await b1.call("kill_process", { process_id: liveStarted.process_id });
  assert.equal(killedFromB.killed, true, JSON.stringify(killedFromB));
  const killedSeenFromA = await a2.call("read_output", { process_id: liveStarted.process_id, wait_ms: 1_000 });
  assert.equal(killedSeenFromA.running, false, JSON.stringify(killedSeenFromA));

  cloneA.child.kill();
  await new Promise((resolveExit) => cloneA.child.once("exit", resolveExit));
  const bHealth = await waitHealth(cloneB.origin, portB);
  assert.equal(bHealth.status, "ok");
  const afterAFailure = await b2.call("start_process", { command: "Write-Output 'B_SURVIVED_A'" });
  let bOutput;
  for (let i = 0; i < 30; i++) {
    await sleep(50);
    bOutput = await b2.call("read_output", { process_id: afterAFailure.process_id });
    if (!bOutput.running) break;
  }
  assert.match(bOutput.stdout, /B_SURVIVED_A/);

  console.log(JSON.stringify({ result: "PASS", tools: expected, state_root_mode: externalStateRoot ? "explicit" : "system-temp", independent_clones: 2, independent_oauth_clients: 4, bootstrap_alias_fresh_snapshots: true, bootstrap_alias_no_accumulated_truncation: true, cross_client_reassociation: true, completed_process_cross_clone_read: true, live_process_cross_clone_read: true, live_process_cross_clone_kill: true, clone_b_survived_clone_a_exit: true }));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  await sleep(100);
  rmSync(temporary, { recursive: true, force: true });
}
