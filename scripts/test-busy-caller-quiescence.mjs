import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "../dist/lib/process-manager.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const root = mkdtempSync(join(tmpdir(), "mcp-busy-quiescence-"));
const busyDir = join(root, "BusyCoordinator");
const busyCommand = join(busyDir, "busy-python.cmd");
mkdirSync(busyDir, { recursive: true });
writeFileSync(busyCommand, `@echo off\r\nif /I "%1"=="release" (\r\n  echo {"ok":true,"released":{"actor":"%2","scope":"%3","timestamp":"%4"}}\r\n  exit /b 0\r\n)\r\necho {"ok":true,"claim":{"actor":"%2","scope":"%3","timestamp":"%4"}}\r\n`);

const recovered = [];
const graceMs = 120;
const manager = new ProcessManager({
  busyQuiescenceGraceMs: graceMs,
  busyClaimRecoverer: async (claim) => { recovered.push(claim); return "recovered"; },
});
const caller = "caller_busy_quiescence_test";
const actor = "ChatGPT:busy-quiescence-test";
const invoke = async (operation, scope, timestamp) => {
  const command = `& '${busyCommand}' ${operation} '${actor}' '${scope}' '${timestamp}'`;
  const result = await manager.startWithWait(command, root, caller, 2_000);
  assert.equal(result.running, false, JSON.stringify(result));
  assert.equal(result.exit_code, 0, JSON.stringify(result));
};

try {
  await invoke("claim", "scope:idle", "2026-09-05T22:00:00.000Z");
  await sleep(50);
  assert.equal(recovered.length, 0, "claim must survive inside the caller-quiescence grace");
  await sleep(120);
  assert.deepEqual(recovered.map((claim) => claim.scope), ["scope:idle"]);

  await invoke("claim", "scope:live", "2026-09-05T22:01:00.000Z");
  const live = manager.start("Start-Sleep -Milliseconds 320", root, caller);
  await sleep(180);
  assert.equal(recovered.some((claim) => claim.scope === "scope:live"), false, "live caller child process must block recovery");
  const liveDone = await manager.readWithWait(live.process_id, 6_000, 2_000);
  assert.equal(liveDone.running, false, JSON.stringify(liveDone));
  await sleep(150);
  assert.equal(recovered.some((claim) => claim.scope === "scope:live"), true, "claim should recover after the live process exits and grace elapses");

  await invoke("claim", "scope:renewed", "2026-09-05T22:02:00.000Z");
  await sleep(40);
  await invoke("heartbeat", "scope:renewed", "2026-09-05T22:02:30.000Z");
  await sleep(150);
  const renewed = recovered.filter((claim) => claim.scope === "scope:renewed");
  assert.equal(renewed.length, 1, JSON.stringify(renewed));
  assert.equal(renewed[0].timestamp, "2026-09-05T22:02:30.000Z", "latest observed claim timestamp must be the CAS recovery target");

  const variableCommand = `$b='${busyCommand}'; & $b claim '${actor}' 'scope:variable' '2026-09-05T22:02:45.000Z'`;
  const variableResult = await manager.startWithWait(variableCommand, root, caller, 2_000);
  assert.equal(variableResult.running, false, JSON.stringify(variableResult));
  await sleep(150);
  assert.equal(recovered.some((claim) => claim.scope === "scope:variable"), true, "PowerShell variable-based Busy invocation must retain caller attribution");

  await invoke("claim", "scope:released", "2026-09-05T22:03:00.000Z");
  await invoke("release", "scope:released", "2026-09-05T22:03:00.000Z");
  await sleep(150);
  assert.equal(recovered.some((claim) => claim.scope === "scope:released"), false, "explicit release must remove the caller-bound recovery candidate");

  const retryTimes = [];
  const retryManager = new ProcessManager({
    busyQuiescenceGraceMs: graceMs,
    busyClaimRecoverer: async () => {
      retryTimes.push(Date.now());
      return retryTimes.length === 1 ? "retry" : "recovered";
    },
  });
  const retryCaller = "caller_busy_quiescence_retry_test";
  const retryCommand = `& '${busyCommand}' claim '${actor}' 'scope:retry' '2026-09-05T22:03:30.000Z'`;
  const retryResult = await retryManager.startWithWait(retryCommand, root, retryCaller, 2_000);
  assert.equal(retryResult.running, false, JSON.stringify(retryResult));
  await sleep(170);
  assert.equal(retryTimes.length, 1, JSON.stringify(retryTimes));
  await sleep(130);
  assert.equal(retryTimes.length, 2, JSON.stringify(retryTimes));
  assert.ok(retryTimes[1] - retryTimes[0] >= graceMs - 20, `transient recovery retry looped too quickly: ${retryTimes[1] - retryTimes[0]}ms`);

  const inspect = await manager.startWithWait(`& '${busyCommand}' inspect '${actor}' 'scope:inspect' '2026-09-05T22:04:00.000Z'`, root, caller, 2_000);
  assert.equal(inspect.running, false, JSON.stringify(inspect));
  await sleep(150);
  assert.equal(recovered.some((claim) => claim.scope === "scope:inspect"), false, "read-only coordinator output must never create recovery ownership");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("PASS caller-bound Busy claims recover after 60s-equivalent quiescence, not during live work, and renew/release semantics stay CAS-safe");
