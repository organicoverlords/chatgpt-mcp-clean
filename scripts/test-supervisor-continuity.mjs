import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 50;
function killTree(pid) {
  if (!pid) return;
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5_000 });
}
const temporary = mkdtempSync(join(tmpdir(), "shell-mcp-supervisor-proof-"));
const configPath = join(temporary, "active-backend.json");
const routesPath = join(temporary, "process-routes.json");
const stateRoot = join(temporary, "supervisors");
const isolatedTransportPath = join(temporary, "transport.jsonl");
const isolatedRequestLogPath = join(temporary, "front-door-request.jsonl");
const isolatedOauthPath = join(temporary, "oauth.json");
const isolatedReceiptPath = join(temporary, "receipts");
const inheritedTransportSentinel = join(temporary, "inherited-transport-must-not-be-used.jsonl");
const inheritedRequestSentinel = join(temporary, "inherited-front-door-must-not-be-used.jsonl");
const inheritedOauthSentinel = join(temporary, "inherited-oauth-must-not-be-used.json");
const inheritedReceiptSentinel = join(temporary, "inherited-receipts-must-not-be-used");
const supervisorEnvironment = {
  ...process.env,
  // Simulate a caller launched from a production MCP backend. Test-mode supervisors must
  // replace these inherited state paths before spawning backend/front-door children.
  MCP_TRANSPORT_LOG_PATH: inheritedTransportSentinel,
  FRONT_DOOR_REQUEST_LOG_PATH: inheritedRequestSentinel,
  MCP_OAUTH_STORE_PATH: inheritedOauthSentinel,
  MCP_PROCESS_RECEIPT_DIR: inheritedReceiptSentinel,
  MCP_BACKEND_CONFIG_PATH: configPath,
  MCP_PROCESS_ROUTE_PATH: routesPath,
  MCP_BACKEND_GENERATION: "",
  MCP_WIREGUARD_CANDIDATE: "0",
  MCP_FORCE_CONNECTION_CLOSE: "0",
};
Object.assign(supervisorEnvironment, {
  MCP_TRANSPORT_LOG_PATH: isolatedTransportPath,
  FRONT_DOOR_REQUEST_LOG_PATH: isolatedRequestLogPath,
  MCP_OAUTH_STORE_PATH: isolatedOauthPath,
  MCP_PROCESS_RECEIPT_DIR: isolatedReceiptPath,
});
const supervisors = [];
let frontDoorPid = 0;
let backendPid = 0;

const reservedPorts = new Set();
async function unusedPort() {
  for (;;) {
    const server = createServer();
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = server.address().port;
    await new Promise((resolveClose) => server.close(resolveClose));
    if (!reservedPorts.has(port)) { reservedPorts.add(port); return port; }
  }
}
async function health(origin) {
  const response = await fetch(`${origin}/health`, { cache: "no-store" });
  assert.equal(response.status, 200);
  return response.json();
}
async function waitHealth(origin, predicate, child) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      const stderr = child.stderrText?.trim();
      throw new Error(`health supervisor exited before ready: ${origin}; exit=${child.exitCode}${stderr ? `; stderr=${stderr.slice(-2000)}` : ""}`);
    }
    try {
      const body = await health(origin);
      if (predicate(body)) return body;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(HEALTH_POLL_MS);
  }
  const stderr = child?.stderrText?.trim();
  throw new Error(`health timeout after ${HEALTH_TIMEOUT_MS}ms: ${origin}${stderr ? `; stderr=${stderr.slice(-2000)}` : ""}${lastError ? `; last_error=${lastError}` : ""}`);
}
function supervisor(args) {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve("keepalive.ps1"), ...args, "-SupervisorStateRoot", stateRoot], {
    cwd: resolve("."), env: supervisorEnvironment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stderrText = "";
  child.stderr.on("data", (chunk) => { child.stderrText += chunk.toString(); });
  supervisors.push(child);
  return child;
}

try {
  const backendPort = await unusedPort();
  const frontDoorPort = await unusedPort();
  const backendSupervisor = supervisor(["-Role", "Backend", "-Port", String(backendPort), "-PollSeconds", "5", "-TestMode"]);
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const originalBackend = await waitHealth(backendOrigin, (body) => body.role === "backend" && body.port === backendPort, backendSupervisor);
  writeFileSync(configPath, `${JSON.stringify({ version: 1, port: backendPort, generation: originalBackend.backend_generation }, null, 2)}\n`, "utf8");
  backendPid = originalBackend.pid;
  const frontDoorSupervisor = supervisor(["-Role", "FrontDoor", "-Port", String(frontDoorPort), "-PollSeconds", "5", "-BackendConfigPath", configPath, "-ProcessRoutePath", routesPath, "-TestMode"]);
  const frontDoorOrigin = `http://127.0.0.1:${frontDoorPort}`;
  const firstFrontDoor = await waitHealth(frontDoorOrigin, (body) => body.name === "shell-mcp" && body.port === frontDoorPort, frontDoorSupervisor);
  frontDoorPid = firstFrontDoor.pid;

  const failures = [];
  let monitoring = true;
  const monitor = (async () => {
    while (monitoring) {
      try {
        const body = await health(frontDoorOrigin);
        if (body.pid !== frontDoorPid) failures.push(`front_door_pid_changed=${body.pid}`);
      } catch (error) { failures.push(error.message); }
      await sleep(10);
    }
  })();

  process.kill(backendPid);
  const replacement = await waitHealth(backendOrigin, (body) => body.role === "backend" && body.pid !== backendPid, backendSupervisor);
  backendPid = replacement.pid;
  await sleep(150);
  monitoring = false;
  await monitor;
  assert.deepEqual(failures, [], `front-door health disappeared while backend supervisor replaced its child: ${failures.join("; ")}`);
  assert.equal(backendSupervisor.exitCode, null, backendSupervisor.stderrText);
  assert.equal(frontDoorSupervisor.exitCode, null, frontDoorSupervisor.stderrText);
  const transportEvidence = readFileSync(isolatedTransportPath, "utf8");
  assert.match(transportEvidence, new RegExp(`"server_pid":${originalBackend.pid}(?:,|})`), "original test backend must write only to the isolated transport log");
  assert.match(transportEvidence, new RegExp(`"server_pid":${replacement.pid}(?:,|})`), "replacement test backend must write only to the isolated transport log");
  for (const forbidden of [inheritedTransportSentinel, inheritedRequestSentinel, inheritedOauthSentinel, inheritedReceiptSentinel]) {
    assert.equal(existsSync(forbidden), false, `test child touched inherited production-like state path: ${forbidden}`);
  }
  console.log(`PASS supervisor_continuity front_door_pid=${frontDoorPid} backend_old_pid=${originalBackend.pid} backend_new_pid=${replacement.pid} health_failures=0 funnel_untouched=test_mode environment_isolated=true`);
} finally {
  for (const child of supervisors) killTree(child.pid);
  for (const pid of [frontDoorPid, backendPid]) killTree(pid);
  rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
