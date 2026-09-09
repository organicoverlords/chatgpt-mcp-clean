#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";


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
async function waitHealth(origin, expectedPort, predicate = () => true, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.status === "ok" && body.port === expectedPort && predicate(body)) return body;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error(`health timeout: ${origin}`);
}

const temporary = mkdtempSync(join(tmpdir(), "minimal-clone-identity-"));
const stableStore = join(temporary, "clone-a", "oauth.json");
mkdirSync(join(temporary, "clone-a"), { recursive: true });
writeFileSync(stableStore, "{}", "utf8");
const script = resolve("scripts/start-minimal-clone.ps1");
const scriptSource = readFileSync(script, "utf8");
assert.match(scriptSource, /canonicalStateRoot = \[IO\.Path\]::GetFullPath\(\(Join-Path \$Root 'minimal-connectors'\)\)/, "canonical state guard must follow the explicit repo root, not the runtime account profile");
function preflight(instanceId = "clone-a-next", extra = []) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-InstanceId", instanceId, "-Port", "3021", "-PublicOrigin", "https://example.test/clone-a", "-StateRoot", temporary, "-ValidateOnly", ...extra], { encoding: "utf8", windowsHide: true });
}
try {
  const missing = preflight();
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stdout}${missing.stderr}`, /must explicitly reuse the stable OAuth store/);
  const wrong = preflight("clone-a-next", ["-OAuthStorePath", join(temporary, "clone-a-next", "oauth.json")]);
  assert.notEqual(wrong.status, 0);
  assert.match(`${wrong.stdout}${wrong.stderr}`, /must be the stable 'clone-a' store/);
  const sameInstanceWrong = preflight("clone-a", ["-OAuthStorePath", join(temporary, "candidate", "oauth.json")]);
  assert.notEqual(sameInstanceWrong.status, 0);
  assert.match(`${sameInstanceWrong.stdout}${sameInstanceWrong.stderr}`, /must be the stable 'clone-a' store/);
  const correct = preflight("clone-a-next", ["-OAuthStorePath", stableStore]);
  assert.equal(correct.status, 0, correct.stderr);
  assert.match(correct.stdout, /IDENTITY_PREFLIGHT_OK/);

  const distIndex = resolve("dist/index.js");
  const originalDist = readFileSync(distIndex);
  const runtimeState = join(temporary, "runtime-state");
  const receipts = join(temporary, "runtime-receipts");
  mkdirSync(runtimeState, { recursive: true });
  mkdirSync(receipts, { recursive: true });
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const launcher = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-InstanceId", "generation-proof", "-Port", String(port), "-PublicOrigin", "https://generation-proof.test.ts.net",
    "-StateRoot", runtimeState, "-SharedReceiptDirectory", receipts, "-SkipBuild",
    "-GenerationProbeMilliseconds", "200", "-GenerationSettleProbeCount", "2",
  ], {
    cwd: resolve("."),
    env: { ...process.env, TAILSCALE_OWNER_LOGIN: "owner@example.com" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let launcherStderr = "";
  launcher.stderr.on("data", (chunk) => { launcherStderr += chunk.toString(); });
  try {
    const first = await waitHealth(origin, port);
    assert.equal(first.runtime_identity?.launcher_bound, true, JSON.stringify(first));
    const changedDist = Buffer.concat([originalDist, Buffer.from(`\n// generation-supervisor-proof-${Date.now()}\n`)]);
    const changedHash = createHash("sha256").update(changedDist).digest("hex");
    writeFileSync(distIndex, changedDist);
    const replacement = await waitHealth(origin, port, (body) => body.pid !== first.pid && body.runtime_identity?.dist_sha256 === changedHash);
    assert.notEqual(replacement.pid, first.pid);
    assert.equal(replacement.runtime_identity?.dist_sha256, changedHash);
    const supervisorLog = readFileSync(join(runtimeState, "generation-proof", "launcher-supervisor.jsonl"), "utf8");
    assert.match(supervisorLog, /"event":"generation_change_restart"/);
  } catch (error) {
    throw new Error(`${error.message}; launcher_exit=${launcher.exitCode}; launcher_stderr=${launcherStderr.slice(-2000)}`);
  } finally {
    if (launcher.pid) spawnSync("taskkill.exe", ["/PID", String(launcher.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    writeFileSync(distIndex, originalDist);
  }
  console.log("PASS minimal_clone_identity_guard unsafe_replacement_blocked=true same_instance_wrong_store_blocked=true stable_store_required=true generation_change_idle_restart=true");
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
