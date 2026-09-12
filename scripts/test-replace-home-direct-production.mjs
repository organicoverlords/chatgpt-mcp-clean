import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const temporary = mkdtempSync(join(tmpdir(), "home-direct-current-port-"));
const topologyPath = join(temporary, "mcp-current-topology.json");
const wrapper = fileURLToPath(new URL("./replace-home-direct-production.ps1", import.meta.url));
const topologyPort = 43210;
const caddyPath = join(temporary, "Caddyfile");
const peerPort = 43211;
writeFileSync(caddyPath, `91-159-12-133.sslip.io {\n\thandle {\n\t\treverse_proxy 127.0.0.1:${topologyPort}\n\t}\n\thandle /x {\n\t\treverse_proxy 127.0.0.1:${topologyPort}\n\t}\n}\n\npr237.91-159-12-133.sslip.io {\n\thandle {\n\t\treverse_proxy 127.0.0.1:${peerPort}\n\t}\n\thandle /x {\n\t\treverse_proxy 127.0.0.1:${peerPort}\n\t}\n}\n`);
writeFileSync(topologyPath, JSON.stringify({
  schema: "mcp-current-topology.v1",
  authority: "current_serving_topology",
  serving: { backend: { listen: `127.0.0.1:${topologyPort}` } },
}, null, 2));

function run(extra = [], candidatePort = topologyPort) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper,
    "-CandidatePort", String(candidatePort), "-CandidateGeneration", "candidate-test", "-Actor", "test", "-BusyScope", "test-scope",
    "-CurrentTopologyPath", topologyPath, "-CaddyConfigPath", caddyPath, ...extra], { encoding: "utf8", windowsHide: true });
}

try {
  const derived = run();
  assert.notEqual(derived.status, 0);
  assert.match(`${derived.stdout}\n${derived.stderr}`, /candidate must use an alternate port/);

  const mismatch = run(["-ExpectedCurrentPort", String(topologyPort + 1)]);
  assert.notEqual(mismatch.status, 0);
  assert.match(`${mismatch.stdout}\n${mismatch.stderr}`, /ExpectedCurrentPort disagrees with current topology/);


  const peerDerived = run(["-StableHost", "pr237.91-159-12-133.sslip.io", "-CurrentPortFromTargetHost"], peerPort);
  assert.notEqual(peerDerived.status, 0);
  assert.match(`${peerDerived.stdout}\n${peerDerived.stderr}`, /candidate must use an alternate port/);

  const peerMismatch = run(["-StableHost", "pr237.91-159-12-133.sslip.io", "-CurrentPortFromTargetHost", "-ExpectedCurrentPort", String(peerPort + 1)], peerPort);
  assert.notEqual(peerMismatch.status, 0);
  assert.match(`${peerMismatch.stdout}\n${peerMismatch.stderr}`, /ExpectedCurrentPort disagrees with target host route/);

  const wrapperSource = readFileSync(wrapper, "utf8");
  assert.match(wrapperSource, /Replace-CaddyTargetUpstream/);
  assert.match(wrapperSource, /curl\.exe -fsS --max-time 5 .*--data-binary/, "Caddy admin load must use curl exact-body POST instead of Windows PowerShell Invoke-WebRequest");
  assert.doesNotMatch(wrapperSource, /Invoke-WebRequest[^\n]*127\.0\.0\.1:2019\/load/, "Caddy admin load must not use the Windows PowerShell Invoke-WebRequest path that throws NullReferenceException");
  assert.doesNotMatch(wrapperSource, /\$candidateText=\$original\.Replace\(\$needle,\$replacement\)/, "replacement must stay scoped to the target host block");

  console.log("PASS home_direct_current_port canonical_topology=true peer_target_host=true block_local_replace=true override_mismatch_fails_closed=true");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
