#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";

const script = fileURLToPath(new URL("./launch-production.ps1", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "mcp-production-launcher-"));

function runLauncher(port) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
      "-Port", String(port), "-InstanceId", "clone-a", "-PublicOrigin", "https://example.test",
      "-StateRoot", temporary, "-SkipBuild",
    ], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
  });
}

function close(server) {
  return new Promise((resolveClose) => server.close(resolveClose));
}

try {
  let port = 0;
  const healthy = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      status: "ok", name: "shell-mcp", role: "backend", port, pid: process.pid,
      backend_generation: "test-generation",
    }));
  });
  port = await listen(healthy);
  const reused = await runLauncher(port);
  assert.equal(reused.code, 0, `${reused.stdout}${reused.stderr}`);
  assert.match(reused.stdout, /MCP_PRODUCTION_ALREADY_HEALTHY/);
  await close(healthy);

  const foreign = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok", name: "not-shell-mcp", role: "backend" }));
  });
  const occupiedPort = await listen(foreign);
  const blocked = await runLauncher(occupiedPort);
  assert.notEqual(blocked.code, 0);
  assert.match(`${blocked.stdout}${blocked.stderr}`, /MCP_PRODUCTION_PORT_OCCUPIED_UNHEALTHY/);
  await close(foreign);

  console.log("PASS production_launcher_guard healthy_listener_reused=true occupied_foreign_listener_fail_closed=true");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
