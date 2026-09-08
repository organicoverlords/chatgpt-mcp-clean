import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
async function requestWithHost(origin, host) {
  return await new Promise((resolveRequest, reject) => {
    const request = httpRequest(new URL("/mcp", origin), { method: "GET", headers: { Host: host } }, (response) => {
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
        if (body.status === "ok" && body.port === port) return;
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
const server = spawn(process.execPath, [resolve("dist/index.js")], {
  cwd: resolve("."),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    MCP_BACKEND_MODE: "1",
    MCP_TOOL_PROFILE: "full",
    MCP_PUBLIC_ORIGIN: publicOrigin,
    TAILSCALE_OWNER_LOGIN: "owner@example.com",
    MCP_OAUTH_STORE_PATH: join(temporary, "oauth.json"),
    MCP_TRANSPORT_LOG_PATH: join(temporary, "transport.jsonl"),
    MCP_PROCESS_RECEIPT_DIR: join(temporary, "receipts"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let serverStderr = "";
server.stderr.on("data", (chunk) => { serverStderr += chunk.toString(); });
try {
  await waitHealth(origin, port);
  const publicHost = new URL(publicOrigin).hostname;
  const bareHost = await requestWithHost(origin, publicHost);
  assert.equal(bareHost.status, 401, `configured public host should reach auth, got ${bareHost.status}: ${bareHost.body}`);
  const defaultPortHost = await requestWithHost(origin, `${publicHost}:443`);
  assert.equal(defaultPortHost.status, 401, `configured public HTTPS host with explicit :443 should reach auth, got ${defaultPortHost.status}: ${defaultPortHost.body}`);
  const nonDefaultPortHost = await requestWithHost(origin, `${publicHost}:444`);
  assert.equal(nonDefaultPortHost.status, 403, `non-default public host port must remain rejected, got ${nonDefaultPortHost.status}: ${nonDefaultPortHost.body}`);
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

  console.log(`PASS local_smoke origin=${origin} stress_rss_dynamic_port=true production_untouched=true`);
} finally {
  if (server.pid) spawnSync("taskkill.exe", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  rmSync(temporary, { recursive: true, force: true });
}