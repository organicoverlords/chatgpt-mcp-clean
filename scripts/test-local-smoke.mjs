import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
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
async function requestWithHost(origin, host, { method = "GET", headers = {} } = {}) {
  return await new Promise((resolveRequest, reject) => {
    const request = httpRequest(new URL("/mcp", origin), { method, headers: { Host: host, ...headers } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolveRequest({ status: response.statusCode ?? 0, body }));
    });
    request.once("error", reject);
    request.end();
  });
}
async function waitHealth(origin, port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.status === "ok" && body.port === port) return body;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error(`local smoke server health timeout: ${origin}`);
}

const temporary = mkdtempSync(join(tmpdir(), "mcp-local-smoke-"));
const port = await unusedPort();
const origin = `http://127.0.0.1:${port}`;
const publicOrigin = "https://branch-smoke.test.ts.net";
const runtimeSourceCommit = "a".repeat(40);
const runtimeDistSha256 = "b".repeat(64);
const server = spawn(process.execPath, [resolve("dist/index.js")], {
  cwd: resolve("."),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    MCP_BACKEND_MODE: "1",
    MCP_WIREGUARD_CANDIDATE: "0",
    MCP_FORCE_CONNECTION_CLOSE: "0",
    MCP_FRONT_DOOR_HOST: "127.0.0.1:3003",
    MCP_TOOL_PROFILE: "full",
    MCP_VISUAL_PROOF_UI: "0",
    MCP_VISUAL_PROOF_REVIEW: "0",
    MCP_PUBLIC_ORIGIN: publicOrigin,
    TAILSCALE_OWNER_LOGIN: "owner@example.com",
    MCP_OAUTH_STORE_PATH: join(temporary, "oauth.json"),
    MCP_TRANSPORT_LOG_PATH: join(temporary, "transport.jsonl"),
    MCP_PROCESS_RECEIPT_DIR: join(temporary, "receipts"),
    MCP_RUNTIME_INSTANCE_ID: "local-smoke",
    MCP_RUNTIME_SOURCE_COMMIT: runtimeSourceCommit,
    MCP_RUNTIME_DIST_SHA256: runtimeDistSha256,
    MCP_RUNTIME_SOURCE_DIRTY: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let serverStderr = "";
server.stderr.on("data", (chunk) => { serverStderr += chunk.toString(); });
try {
  const health = await waitHealth(origin, port);
  assert.deepEqual(health.runtime_identity, {
    launcher_bound: true,
    instance_id: "local-smoke",
    source_commit: runtimeSourceCommit,
    dist_sha256: runtimeDistSha256,
    source_dirty: false,
  });
  const launcher = readFileSync(resolve("scripts/start-minimal-clone.ps1"), "utf8");
  for (const required of [
    "$env:MCP_RUNTIME_INSTANCE_ID = $InstanceId",
    "$env:MCP_RUNTIME_SOURCE_COMMIT = [string]$Identity.source_commit",
    "$env:MCP_RUNTIME_DIST_SHA256 = [string]$Identity.dist_sha256",
    "$env:MCP_RUNTIME_SOURCE_DIRTY = if ($Identity.source_dirty) { '1' } else { '0' }",
  ]) assert.ok(launcher.includes(required), `launcher missing runtime identity binding: ${required}`);
  assert.match(launcher, /Get-FileHash -LiteralPath \$runtimeDistIndex -Algorithm SHA256/);
  const publicHost = new URL(publicOrigin).hostname;
  const bareHost = await requestWithHost(origin, publicHost);
  assert.equal(bareHost.status, 401, `configured public host should reach auth, got ${bareHost.status}: ${bareHost.body}`);
  const defaultPortHost = await requestWithHost(origin, `${publicHost}:443`);
  assert.equal(defaultPortHost.status, 401, `configured public HTTPS host with explicit :443 should reach auth, got ${defaultPortHost.status}: ${defaultPortHost.body}`);
  const nonDefaultPortHost = await requestWithHost(origin, `${publicHost}:444`);
  assert.equal(nonDefaultPortHost.status, 403, `non-default public host port must remain rejected, got ${nonDefaultPortHost.status}: ${nonDefaultPortHost.body}`);
  const untrustedOrigin = await requestWithHost(origin, publicHost, { method: "POST", headers: { Origin: "https://attacker.invalid" } });
  assert.equal(untrustedOrigin.status, 403, `untrusted Origin must be rejected before bearer auth, got ${untrustedOrigin.status}: ${untrustedOrigin.body}`);
  assert.match(untrustedOrigin.body, /Invalid Origin header/);
  const trustedPublicOrigin = await requestWithHost(origin, publicHost, { method: "POST", headers: { Origin: new URL(publicOrigin).origin } });
  assert.equal(trustedPublicOrigin.status, 401, `configured public Origin should reach bearer auth, got ${trustedPublicOrigin.status}: ${trustedPublicOrigin.body}`);
  const trustedLocalOrigin = await requestWithHost(origin, `127.0.0.1:${port}`, { method: "POST", headers: { Origin: origin } });
  assert.equal(trustedLocalOrigin.status, 401, `direct local Origin should reach bearer auth, got ${trustedLocalOrigin.status}: ${trustedLocalOrigin.body}`);
  const trustedFrontDoorOrigin = await requestWithHost(origin, "127.0.0.1:3003", { method: "POST", headers: { Origin: "http://127.0.0.1:3003" } });
  assert.equal(trustedFrontDoorOrigin.status, 401, `front-door Origin should reach bearer auth, got ${trustedFrontDoorOrigin.status}: ${trustedFrontDoorOrigin.body}`);
  const smoke = spawn(process.execPath, [resolve("scripts/smoke.mjs")], {
    cwd: resolve("."),
    env: {
      ...process.env,
      MCP_SMOKE_ORIGIN: origin,
      MCP_SMOKE_PUBLIC_ORIGIN: publicOrigin,
      MCP_TOOL_PROFILE: "full",
      TAILSCALE_OWNER_LOGIN: "owner@example.com",
    },
    stdio: "inherit",
    windowsHide: true,
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    smoke.once("error", reject);
    smoke.once("exit", (code) => resolveExit(code ?? 1));
  });
  assert.equal(exitCode, 0, `local smoke failed; server stderr: ${serverStderr}`);

  const stress = spawn(process.execPath, [resolve("scripts/stress.mjs")], {
    cwd: resolve("."),
    env: {
      ...process.env,
      MCP_SMOKE_ORIGIN: origin,
      MCP_PUBLIC_ORIGIN: publicOrigin,
      MCP_TOOL_PROFILE: "full",
      TAILSCALE_OWNER_LOGIN: "owner@example.com",
      STRESS_BURST: "1",
      STRESS_SUSTAINED: "1",
      STRESS_CONCURRENCY: "1",
      STRESS_PROCS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stressStdout = "";
  let stressStderr = "";
  stress.stdout.on("data", (chunk) => { stressStdout += chunk.toString(); });
  stress.stderr.on("data", (chunk) => { stressStderr += chunk.toString(); });
  const stressExitCode = await new Promise((resolveExit, reject) => {
    stress.once("error", reject);
    stress.once("exit", (code) => resolveExit(code ?? 1));
  });
  assert.equal(stressExitCode, 0, `dynamic-port stress failed: ${stressStdout}
${stressStderr}`);
  assert.doesNotMatch(stressStdout, /rss=nullMB/, `dynamic-port stress lost RSS measurement: ${stressStdout}`);
  assert.match(stressStdout, /baseline: rss=\d+(?:\.\d+)?MB/, `dynamic-port stress did not report baseline RSS: ${stressStdout}`);
  assert.match(stressStdout, /rss=\d+(?:\.\d+)?MB \(baseline \d+(?:\.\d+)?MB\)/, `dynamic-port stress did not report settled RSS: ${stressStdout}`);
  assert.equal(stressStderr.trim(), "", `dynamic-port stress emitted stderr: ${stressStderr}`);

  console.log(`PASS local_smoke origin=${origin} stress_rss_dynamic_port=true production_untouched=true runtime_identity_bound=true origin_guard=true`);
} finally {
  if (server.pid) spawnSync("taskkill.exe", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  rmSync(temporary, { recursive: true, force: true });
}