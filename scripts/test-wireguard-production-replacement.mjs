import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const launcher = readFileSync(new URL("./start-minimal-clone.ps1", import.meta.url), "utf8");
const request = readFileSync(new URL("./replace-wireguard-production.ps1", import.meta.url), "utf8");
const guardian = readFileSync(new URL("./production-replacement-guardian.ps1", import.meta.url), "utf8");
const candidate = readFileSync(new URL("./production-replacement-candidate.ps1", import.meta.url), "utf8");
const installer = readFileSync(new URL("./install-production-replacement-task.ps1", import.meta.url), "utf8");
const busyGuard = readFileSync(new URL("./assert-live-busy-claim.ps1", import.meta.url), "utf8");

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
assert.match(guardian, /\[DateTimeOffset\]::ParseExact/);
assert.match(guardian, /\[Globalization\.CultureInfo\]::InvariantCulture/);
assert.match(guardian, /replacement request timestamp is not valid invariant ISO-8601 round-trip format/);
const ambiguousIsoTimestamp = "2026-09-05T20:34:40.4090068Z";
const parsedIsoTimestamp = execFileSync("pwsh.exe", [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
  `[System.Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo('fi-FI'); ` +
    `[DateTimeOffset]::ParseExact('${ambiguousIsoTimestamp}', 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None).UtcDateTime.ToString('o')`,
], { encoding: "utf8" }).trim();
assert.equal(parsedIsoTimestamp, ambiguousIsoTimestamp, "ambiguous yyyy-MM-dd request timestamp must stay culture-invariant");
assert.match(busyGuard, /BusyCoordinator\\busy\.py/);
assert.match(busyGuard, /inspect \$Scope/);
assert.match(busyGuard, /claim\.actor/);
assert.match(request, /assert-live-busy-claim\.ps1/);
assert.match(request, /-Scope \$requiredScope -Actor/);
assert.ok((guardian.match(/-Scope \$requiredScope -Actor/g) ?? []).length >= 4, "guardian must revalidate live Busy before forward serving mutations");
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
