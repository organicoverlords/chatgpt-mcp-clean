import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
const publicOrigin = "https://branch-smoke.invalid";
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
  console.log(`PASS local_smoke origin=${origin} production_untouched=true`);
} finally {
  if (server.pid) spawnSync("taskkill.exe", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  rmSync(temporary, { recursive: true, force: true });
}