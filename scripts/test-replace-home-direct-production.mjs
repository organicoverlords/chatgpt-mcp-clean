import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const temporary = mkdtempSync(join(tmpdir(), "home-direct-current-port-"));
const topologyPath = join(temporary, "mcp-current-topology.json");
const wrapper = fileURLToPath(new URL("./replace-home-direct-production.ps1", import.meta.url));
const topologyPort = 43210;
writeFileSync(topologyPath, JSON.stringify({
  schema: "mcp-current-topology.v1",
  authority: "current_serving_topology",
  serving: { backend: { listen: `127.0.0.1:${topologyPort}` } },
}, null, 2));

function run(extra = []) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper,
    "-CandidatePort", String(topologyPort), "-CandidateGeneration", "candidate-test", "-Actor", "test", "-BusyScope", "test-scope",
    "-CurrentTopologyPath", topologyPath, ...extra], { encoding: "utf8", windowsHide: true });
}

try {
  const derived = run();
  assert.notEqual(derived.status, 0);
  assert.match(`${derived.stdout}\n${derived.stderr}`, /candidate must use an alternate port/);

  const mismatch = run(["-ExpectedCurrentPort", String(topologyPort + 1)]);
  assert.notEqual(mismatch.status, 0);
  assert.match(`${mismatch.stdout}\n${mismatch.stderr}`, /ExpectedCurrentPort disagrees with current topology/);

  console.log("PASS home_direct_current_port canonical_topology=true stale_default_removed=true override_mismatch_fails_closed=true");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
