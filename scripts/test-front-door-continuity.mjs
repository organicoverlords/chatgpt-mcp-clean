import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const temporary = mkdtempSync(join(tmpdir(), "shell-mcp-front-door-"));
const configPath = join(temporary, "active-backend.json");
const routesPath = join(temporary, "process-routes.json");
const requestLogPath = join(temporary, "front-door-request.jsonl");
const processId = "11111111-1111-4111-8111-111111111111";
let releaseSlow;
const slowGate = new Promise((resolveSlow) => { releaseSlow = resolveSlow; });

function jsonRpc(id, value) {
  return JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function backend(name) {
  const server = createServer(async (request, response) => {
    if (request.url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", name: "shell-mcp", role: "backend", backend_generation: `${name}-1`, backend: name }));
      return;
    }
    if (request.url === "/slow") {
      await slowGate;
      response.end(`slow-${name}`);
      return;
    }
    if (request.url === "/identity") {
      response.end(name);
      return;
    }
    const raw = await requestBody(request);
    let rpc = {};
    try { rpc = JSON.parse(raw); } catch {}
    const tool = rpc?.params?.name;
    const args = rpc?.params?.arguments || {};
    response.setHeader("content-type", "application/json");
    if (tool === "start_process") response.end(jsonRpc(rpc.id, { process_id: processId, running: true, backend: name }));
    else if (tool === "read_output") response.end(jsonRpc(rpc.id, { process_id: args.process_id, running: true, stdout: name }));
    else response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { backend: name } }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return { server, port: server.address().port };
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function writeTarget(port, generation) {
  writeFileSync(configPath, `${JSON.stringify({ version: 1, port, generation }, null, 2)}\n`, "utf8");
}

function requestLogEntries() {
  try {
    return readFileSync(requestLogPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitForRequestLog(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const entries = requestLogEntries();
    if (predicate(entries)) return entries;
    await sleep(20);
  }
  throw new Error("front-door request telemetry did not appear");
}

async function waitForHealth(origin) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${origin}/health`);
      const body = await response.json();
      if (response.ok && body.name === "shell-mcp" && body.port === Number(new URL(origin).port)) return body;
    } catch {}
    await sleep(25);
  }
  throw new Error("front door did not become healthy");
}

async function toolCall(origin, name, args) {
  return fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
  });
}

let frontDoor;
let first;
let second;
try {
  first = await backend("blue");
  second = await backend("green");
  const frontDoorPort = await unusedPort();
  writeTarget(first.port, "blue-1");
  frontDoor = spawn(process.execPath, [resolve("dist/front-door.js")], {
    env: { ...process.env, FRONT_DOOR_PORT: String(frontDoorPort), MCP_BACKEND_CONFIG_PATH: configPath, MCP_PROCESS_ROUTE_PATH: routesPath, FRONT_DOOR_REQUEST_LOG_PATH: requestLogPath },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let frontDoorError = "";
  frontDoor.stderr.on("data", (chunk) => { frontDoorError += chunk.toString(); });
  const origin = `http://127.0.0.1:${frontDoorPort}`;
  await waitForHealth(origin);

  const healthFailures = [];
  let monitor = true;
  const monitorPromise = (async () => {
    while (monitor) {
      try {
        const response = await fetch(`${origin}/health`, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok || body.name !== "shell-mcp") healthFailures.push(`status=${response.status}`);
      } catch (error) {
        healthFailures.push(error.message);
      }
      await sleep(10);
    }
  })();

  const started = await toolCall(origin, "start_process", { command: "test" });
  assert.equal(started.status, 200);
  assert.equal(JSON.parse(JSON.parse(await started.text()).result.content[0].text).backend, "blue");
  const requestEvidence = await waitForRequestLog((entries) => entries.some((entry) => entry.event === "front_backend_dispatch"));
  assert.ok(requestEvidence.some((entry) => entry.event === "front_request_start" && entry.path === "/mcp"));
  assert.ok(requestEvidence.some((entry) => entry.event === "front_backend_select" && entry.tool === "start_process" && entry.backend_port === first.port));
  assert.ok(requestEvidence.some((entry) => entry.event === "front_backend_dispatch" && entry.backend_port === first.port));
  assert.equal(readFileSync(requestLogPath, "utf8").includes('"command":"test"'), false, "front-door telemetry must not log tool arguments or request bodies");

  const slow = fetch(`${origin}/slow`).then((response) => response.text());
  await sleep(30);
  writeTarget(second.port, "green-1");
  assert.equal(await (await fetch(`${origin}/identity`)).text(), "green");
  releaseSlow();
  assert.equal(await slow, "slow-blue", "an in-flight request must drain on its original backend");

  const pinned = await toolCall(origin, "read_output", { process_id: processId });
  assert.equal(pinned.status, 200);
  assert.equal(JSON.parse(JSON.parse(await pinned.text()).result.content[0].text).stdout, "blue", "same process_id must stay pinned to its creating backend");

  await new Promise((resolveClose) => first.server.close(resolveClose));
  const unavailable = await toolCall(origin, "read_output", { process_id: processId });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "Service unavailable" });
  const routeState = JSON.parse(await (await import("node:fs/promises")).readFile(routesPath, "utf8"));
  assert.equal(routeState.routes[processId].port, first.port, "a dead pinned backend must remain internal state and must not fall through to a new backend");

  await sleep(100);
  monitor = false;
  await monitorPromise;
  assert.deepEqual(healthFailures, [], `front-door health disappeared: ${healthFailures.join("; ")}`);
  const finalHealth = await (await fetch(`${origin}/health`)).json();
  assert.equal(finalHealth.status, "ok");
  console.log(`PASS front_door_continuity health_failures=0 active_switch=blue-to-green in_flight_drained=true process_id_pinned=true unavailable_route_preserved=true front_door_pid=${finalHealth.pid}`);

  assert.equal(frontDoor.exitCode, null, frontDoorError);
} finally {
  releaseSlow?.();
  if (frontDoor && frontDoor.exitCode === null) frontDoor.kill();
  if (first?.server.listening) await new Promise((resolveClose) => first.server.close(resolveClose));
  if (second?.server.listening) await new Promise((resolveClose) => second.server.close(resolveClose));
  await sleep(50);
  rmSync(temporary, { recursive: true, force: true });
}
