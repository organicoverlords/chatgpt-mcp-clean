import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const launcher = readFileSync(new URL("./start-minimal-clone.ps1", import.meta.url), "utf8");
const request = readFileSync(new URL("./replace-wireguard-production.ps1", import.meta.url), "utf8");
const guardian = readFileSync(new URL("./production-replacement-guardian.ps1", import.meta.url), "utf8");
const candidate = readFileSync(new URL("./production-replacement-candidate.ps1", import.meta.url), "utf8");
const installer = readFileSync(new URL("./install-production-replacement-task.ps1", import.meta.url), "utf8");

assert.match(index, /MCP_WIREGUARD_CANDIDATE/);
assert.match(index, /wireGuardHost = "10\.203\.0\.2"/);
assert.match(index, /PORT !== 3011/);
assert.match(index, /approvedWireGuardCandidateBind/);
assert.match(index, /wireGuardCandidate \? \["loopback", wireGuardPeer\] : "loopback"/);
assert.match(index, /wireguard_candidate: wireGuardCandidate/);
assert.match(index, /processRuntimeStatus/);
assert.match(launcher, /\[switch\]\$WireGuardCandidate/);
assert.match(launcher, /WireGuard candidate must use an alternate port/);
assert.match(launcher, /MCP_WIREGUARD_CANDIDATE/);
assert.match(launcher, /10\.203\.0\.2/);
assert.match(request, /GateReceiptPath/);
assert.match(request, /production-change-gate receipt does not PASS/);
assert.match(request, /mcp_minimal_clone:production-backend-3011/);
assert.match(guardian, /gate_receipt_sha256/);
assert.match(guardian, /Wait-CandidateDrain/);
assert.match(guardian, /SUCCEEDED_CANDIDATE_DRAIN_PENDING/);
assert.match(guardian, /ROLLED_BACK_CANDIDATE_DRAIN_PENDING/);
assert.match(installer, /ExplicitUserAuthorization/);
assert.match(installer, /McpV3ProductionReplacementGuardian/);

for (const required of ["ExplicitUserAuthorization", "IndependentRollbackVerified", "OffPathProofVerified"]) assert.match(request, new RegExp(required));
assert.match(request, /ExpectedCurrentGeneration/);
assert.match(request, /ExpectedCaddySha256/);
assert.match(request, /canonical MCP freeze/);
assert.match(request, /candidate_port = 3012/);
assert.match(request, /Start-ScheduledTask -TaskName \$guardianTask/);

assert.match(candidate, /candidate_port -ne 3012/);
assert.match(candidate, /expected_candidate_commit/);
assert.match(candidate, /-WireGuardCandidate/);
assert.match(candidate, /shared-process-receipts/);

assert.match(installer, /McpV3ProductionReplacementGuardian/);
assert.match(installer, /McpV3ProductionReplacementCandidate/);
assert.match(installer, /MultipleInstances IgnoreNew/);

const stages = [
  "Start-ScheduledTask -TaskName $candidateTask",
  "Invoke-EdgePort 3012",
  "Wait-BackendDrain $oldPid",
  "Stop-ScheduledTask -TaskName $productionTask",
  "switch --detach $expectedCommit",
  "Start-ScheduledTask -TaskName $productionTask",
  "Invoke-EdgePort 3011",
  "Stop-TaskIfRunning $candidateTask",
];
const order = [];
let cursor = 0;
for (const stage of stages) {
  const found = guardian.indexOf(stage, cursor);
  assert.ok(found >= 0, `replacement transaction stage missing after ${cursor}: ${stage}`);
  order.push(found);
  cursor = found + stage.length;
}
assert.match(guardian, /live_process_count/);
assert.match(guardian, /Get-DirectChildren/);
assert.match(guardian, /ROLLED_BACK/);
assert.match(guardian, /DEGRADED_CANDIDATE_SERVING/);
assert.match(guardian, /McpV3ProductionReplacementCandidate/);
assert.match(guardian, /candidate_dist_sha256/);
assert.match(guardian, /old_dist_sha256/);

console.log("PASS wireguard_replacement_contract independent_candidate_task=true candidate_first=true drain_before_stop=true canonical_supervisor_reused=true rollback_or_candidate_serving=true");
