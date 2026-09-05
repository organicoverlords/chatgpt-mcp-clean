import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { request } from "node:http";

const WG_HOST = "10.203.0.2";
const VPS_HOST = "5.61.91.127";
const PUBLIC_HOST = "5-61-91-127.sslip.io";
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function hasWireGuardHost() {
  return Object.values(networkInterfaces()).flat().some((entry) => entry?.family === "IPv4" && entry.address === WG_HOST);
}

async function replacementWireGuardPort() {
  const port = 3012;
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, WG_HOST, resolveListen);
  });
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function waitHealth(origin, child) {
  const deadline = Date.now() + 30_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`candidate exited before health; exit=${child.exitCode}; stderr=${child.stderrText.slice(-2000)}`);
    try {
      const response = await fetch(`${origin}/health`);
      const body = await response.json();
      if (response.ok && body.status === "ok") return body;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(`candidate health timeout: ${lastError}; stderr=${child.stderrText.slice(-2000)}`);
}

async function hostStatus(origin, host) {
  const url = new URL(`${origin}/mcp`);
  return await new Promise((resolveStatus, reject) => {
    const req = request({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method: "GET", headers: { Host: host } }, (res) => {
      res.resume();
      res.once("end", () => resolveStatus(res.statusCode));
    });
    req.once("error", reject);
    req.end();
  });
}

if (process.platform !== "win32") throw new Error("WireGuard replacement proof is Windows-specific");
if (!hasWireGuardHost()) throw new Error(`required WireGuard address is not present: ${WG_HOST}`);

const port = await replacementWireGuardPort();
const temporary = mkdtempSync(join(tmpdir(), "mcp-wg-candidate-proof-"));
const child = spawn(process.execPath, [resolve("dist/index.js")], {
  env: {
    ...process.env,
    PORT: String(port),
    HOST: WG_HOST,
    MCP_BACKEND_MODE: "1",
    MCP_WIREGUARD_CANDIDATE: "1",
    MCP_TOOL_PROFILE: "process",
    MCP_PUBLIC_ORIGIN: `https://${PUBLIC_HOST}`,
    TAILSCALE_OWNER_LOGIN: "wireguard-proof@example.com",
    MCP_OAUTH_STORE_PATH: join(temporary, "oauth.json"),
    MCP_TRANSPORT_LOG_PATH: join(temporary, "transport.jsonl"),
    MCP_PROCESS_RECEIPT_DIR: join(temporary, "receipts"),
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderrText = "";
child.stderr.on("data", (chunk) => { child.stderrText += chunk.toString(); });

try {
  const origin = `http://${WG_HOST}:${port}`;
  const health = await waitHealth(origin, child);
  assert.equal(health.role, "backend");
  assert.equal(health.host, WG_HOST);
  assert.equal(health.port, port);
  assert.equal(health.wireguard_candidate, true);
  assert.equal(health.live_process_count, 0);
  assert.equal(await hostStatus(origin, PUBLIC_HOST), 401);
  assert.equal(await hostStatus(origin, `${PUBLIC_HOST}:443`), 401);
  assert.equal(await hostStatus(origin, `${PUBLIC_HOST}:444`), 403);

  const ssh = "C:\\Program Files\\Git\\usr\\bin\\ssh.exe";
  const key = join(homedir(), ".ssh", "tietokettu_edge");
  if (!existsSync(ssh) || !existsSync(key)) throw new Error("VPS SSH proof route is unavailable");
  const remoteText = execFileSync(ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-i", key, `root@${VPS_HOST}`, `curl -fsS --max-time 5 http://${WG_HOST}:${port}/health`], { encoding: "utf8", timeout: 10_000 }).trim();
  const remoteHealth = JSON.parse(remoteText);
  assert.equal(remoteHealth.status, "ok");
  assert.equal(remoteHealth.backend_generation, health.backend_generation);
  assert.equal(remoteHealth.host, WG_HOST);
  assert.equal(remoteHealth.port, port);
  assert.equal(remoteHealth.wireguard_candidate, true);

  console.log(`PASS wireguard_candidate_offpath host=${WG_HOST} port=${port} generation=${health.backend_generation} vps_health=200 bare=401 explicit443=401 nondefault444=403 canonical_3011_untouched=true`);
} finally {
  child.kill();
  await sleep(250);
  rmSync(temporary, { recursive: true, force: true });
}
