import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const temporary = mkdtempSync(join(tmpdir(), "shell-mcp-supervisor-proof-"));
const configPath = join(temporary, "active-backend.json");
const routesPath = join(temporary, "process-routes.json");
const stateRoot = join(temporary, "supervisors");
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
async function waitHealth(origin, predicate) {
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const body = await health(origin);
      if (predicate(body)) return body;
    } catch {}
    await sleep(50);
  }
  throw new Error(`health timeout: ${origin}`);
}
function supervisor(args) {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve("keepalive.ps1"), ...args, "-SupervisorStateRoot", stateRoot], { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
  const originalBackend = await waitHealth(backendOrigin, (body) => body.role === "backend" && body.port === backendPort);
  writeFileSync(configPath, `${JSON.stringify({ version: 1, port: backendPort, generation: originalBackend.backend_generation }, null, 2)}\n`, "utf8");
  backendPid = originalBackend.pid;
  const frontDoorSupervisor = supervisor(["-Role", "FrontDoor", "-Port", String(frontDoorPort), "-PollSeconds", "5", "-BackendConfigPath", configPath, "-ProcessRoutePath", routesPath, "-TestMode"]);
  const frontDoorOrigin = `http://127.0.0.1:${frontDoorPort}`;
  const firstFrontDoor = await waitHealth(frontDoorOrigin, (body) => body.name === "shell-mcp" && body.port === frontDoorPort);
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
  const replacement = await waitHealth(backendOrigin, (body) => body.role === "backend" && body.pid !== backendPid);
  backendPid = replacement.pid;
  await sleep(150);
  monitoring = false;
  await monitor;
  assert.deepEqual(failures, [], `front-door health disappeared while backend supervisor replaced its child: ${failures.join("; ")}`);
  assert.equal(backendSupervisor.exitCode, null, backendSupervisor.stderrText);
  assert.equal(frontDoorSupervisor.exitCode, null, frontDoorSupervisor.stderrText);
  console.log(`PASS supervisor_continuity front_door_pid=${frontDoorPid} backend_old_pid=${originalBackend.pid} backend_new_pid=${replacement.pid} health_failures=0 funnel_untouched=test_mode`);
} finally {
  for (const child of supervisors) if (child.exitCode === null) child.kill();
  await sleep(150);
  for (const pid of [frontDoorPid, backendPid]) {
    if (!pid) continue;
    try { process.kill(pid); } catch {}
  }
  await sleep(100);
  rmSync(temporary, { recursive: true, force: true });
}
