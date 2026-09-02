import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const temporary = mkdtempSync(join(tmpdir(), "shell-mcp-front-reuse-"));
const configPath = join(temporary, "active-backend.json");
const routesPath = join(temporary, "process-routes.json");
const staticRoutePath = join(temporary, "static-routes.json");
const requestLogPath = join(temporary, "front-door-request.jsonl");
let backend;
let frontDoor;
let connectionCount = 0;

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitForHealth(origin) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(25);
  }
  throw new Error("front door did not become healthy");
}

try {
  backend = createServer((request, response) => {
    const backendPort = backend.address().port;
    if (request.url === "/identity") {
      response.end("clone-a");
      return;
    }
    if (request.url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", name: "shell-mcp", role: "backend", backend_generation: "reuse-proof", port: backendPort }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  backend.on("connection", () => { connectionCount += 1; });
  await new Promise((resolveListen) => backend.listen(0, "127.0.0.1", resolveListen));
  const backendPort = backend.address().port;
  const frontDoorPort = await unusedPort();
  writeFileSync(configPath, `${JSON.stringify({ version: 1, port: backendPort, generation: "reuse-proof" }, null, 2)}\n`);
  writeFileSync(routesPath, `${JSON.stringify({ version: 1, routes: {} }, null, 2)}\n`);
  writeFileSync(staticRoutePath, `${JSON.stringify({ version: 1, routes: { "clone-a": [backendPort] } }, null, 2)}\n`);
  frontDoor = spawn(process.execPath, [resolve("dist/front-door.js")], {
    env: {
      ...process.env,
      FRONT_DOOR_PORT: String(frontDoorPort),
      MCP_BACKEND_CONFIG_PATH: configPath,
      MCP_PROCESS_ROUTE_PATH: routesPath,
      FRONT_DOOR_STATIC_ROUTE_PATH: staticRoutePath,
      FRONT_DOOR_REQUEST_LOG_PATH: requestLogPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let frontDoorError = "";
  frontDoor.stderr.on("data", (chunk) => { frontDoorError += chunk.toString(); });
  const origin = `http://127.0.0.1:${frontDoorPort}`;
  await waitForHealth(origin);
  for (let i = 0; i < 60; i += 1) {
    const response = await fetch(`${origin}/clone-a/identity`);
    assert.equal(response.status, 200, frontDoorError);
    assert.equal(await response.text(), "clone-a");
  }
  assert.ok(connectionCount <= 2, `front door opened ${connectionCount} backend TCP connections for 60 sequential clone requests`);
  assert.equal(frontDoor.exitCode, null, frontDoorError);
  console.log(`PASS front_door_connection_reuse requests=60 backend_connections=${connectionCount}`);
} finally {
  if (frontDoor && frontDoor.exitCode === null) frontDoor.kill();
  if (backend?.listening) await new Promise((resolveClose) => backend.close(resolveClose));
  await sleep(50);
  rmSync(temporary, { recursive: true, force: true });
}
