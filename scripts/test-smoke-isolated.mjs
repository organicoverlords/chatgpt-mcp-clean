import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
const temporary = mkdtempSync(join(tmpdir(), "shell-mcp-smoke-isolated-"));
const children = [];

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitHealth(origin, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${origin}/health`, { cache: "no-store" });
      if (response.ok) return await response.json();
    } catch {}
    if (child.exitCode !== null) break;
    await sleep(25);
  }
  throw new Error(`isolated smoke backend did not become healthy: ${child.stderrText}`);
}

function launch(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: resolve("."),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    // On this Windows/Node runtime, CREATE_NO_WINDOW can leave a spawned Node
    // child alive before it binds its listener. The disposable test must observe
    // the real server startup, so keep the child attached to the parent process.
    windowsHide: false,
  });
  child.stderrText = "";
  child.stderr.on("data", (chunk) => { child.stderrText += chunk.toString(); });
  children.push(child);
  return child;
}

const port = await unusedPort();
const origin = `http://127.0.0.1:${port}`;
const server = launch(["dist/index.js"], {
  PORT: String(port),
  MCP_BACKEND_MODE: "1",
  MCP_TOOL_PROFILE: "full",
  MCP_PUBLIC_ORIGIN: "https://smoke-proof.ts.net",
  TAILSCALE_OWNER_LOGIN: "owner@example.com",
  MCP_OAUTH_STORE_PATH: join(temporary, "oauth.json"),
  MCP_BUSY_STORE_PATH: join(temporary, "busy.json"),
  MCP_PROCESS_RECEIPT_DIR: join(temporary, "receipts"),
  MCP_TRANSPORT_LOG_PATH: join(temporary, "transport.jsonl"),
});

try {
  const health = await waitHealth(origin, server);
  assert.equal(health.role, "backend");
  const smoke = launch(["scripts/smoke.mjs"], {
    MCP_SMOKE_ORIGIN: origin,
    MCP_SMOKE_RESOURCE: "https://smoke-proof.ts.net/mcp",
    TAILSCALE_OWNER_LOGIN: "owner@example.com",
  });
  const output = await new Promise((resolveResult, rejectResult) => {
    let stdout = "";
    let stderr = "";
    smoke.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    smoke.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    smoke.on("error", rejectResult);
    smoke.on("close", (code) => resolveResult({ code, stdout, stderr }));
  });
  assert.equal(output.code, 0, `${output.stdout}\n${output.stderr}`);
  process.stdout.write(output.stdout);
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  await sleep(150);
  rmSync(temporary, { recursive: true, force: true });
}
