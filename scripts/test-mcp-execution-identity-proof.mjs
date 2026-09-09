#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const temporary = mkdtempSync(join(tmpdir(), "mcp-identity-proof-contract-"));
const proofRoot = join(temporary, "proof-must-not-exist");
const harness = resolve("scripts/prove-mcp-execution-identity.ps1");
const probe = resolve("scripts/mcp-execution-identity-probe.ps1");
const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

try {
  const before = execFileSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", "@((Get-ScheduledTask -TaskName 'McpIdentityProof-*' -ErrorAction SilentlyContinue)).Count"], { encoding: "utf8" }).trim();
  const result = spawnSync(pwsh, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness,
    "-PrincipalUserId", "KONE\\McpServiceProof",
    "-SourceRoot", resolve("."),
    "-ProofRoot", proofRoot,
    "-ValidateOnly",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const validated = JSON.parse(result.stdout.trim());
  assert.equal(validated.status, "MCP_EXECUTION_IDENTITY_PROOF_VALIDATED");
  assert.equal(validated.principal_resolved, false);
  assert.equal(validated.task_logon_type, "S4U");
  assert.equal(validated.task_run_level, "Limited");
  assert.equal(validated.network_model, "S4U_LOCAL_ONLY_NO_NETWORK_CREDENTIALS");
  assert.equal(validated.network_dependent_orchestration, "REPLACEMENT_GUARDIAN_HOST_CONTROL_IDENTITY");
  assert.equal(validated.process_tool_compatibility_probe, "scripts/test-minimal-clones.mjs");
  assert.ok(validated.node_exe_path.toLowerCase().endsWith("node.exe"));
  assert.equal(validated.mutates_task_scheduler, false);
  assert.equal(validated.touches_production_tasks, false);
  assert.equal(existsSync(proofRoot), false, "validate-only must not create proof state");
  const after = execFileSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", "@((Get-ScheduledTask -TaskName 'McpIdentityProof-*' -ErrorAction SilentlyContinue)).Count"], { encoding: "utf8" }).trim();
  assert.equal(after, before, "validate-only must not register a scheduled task");

  const missingPrincipalProof = spawnSync(pwsh, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness,
    "-PrincipalUserId", "KONE\\McpServiceProof",
    "-SourceRoot", resolve("."),
    "-ProofRoot", proofRoot,
    "-ExecuteProof",
  ], { encoding: "utf8", windowsHide: true });
  assert.notEqual(missingPrincipalProof.status, 0, "execute-proof must fail when the dedicated principal does not exist");
  assert.match(`${missingPrincipalProof.stdout}${missingPrincipalProof.stderr}`, /must already exist and resolve/);
  assert.equal(existsSync(proofRoot), false, "missing-principal refusal must happen before proof-state mutation");
  const afterRefusal = execFileSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", "@((Get-ScheduledTask -TaskName 'McpIdentityProof-*' -ErrorAction SilentlyContinue)).Count"], { encoding: "utf8" }).trim();
  assert.equal(afterRefusal, before, "missing-principal refusal must not register a scheduled task");

  const harnessSource = readFileSync(harness, "utf8");
  const probeSource = readFileSync(probe, "utf8");
  const processSmokeSource = readFileSync(resolve("scripts/test-minimal-clones.mjs"), "utf8");
  for (const productionName of ["McpV3Production3011", "McpV3ProductionReplacementGuardian", "McpV3ProductionReplacementCandidate", "McpVpsEdgeTunnel"]) {
    assert.equal(harnessSource.includes(productionName), false, `proof harness must not reference production task ${productionName}`);
  }
  assert.match(harnessSource, /LogonType S4U/);
  assert.match(harnessSource, /RunLevel Limited/);
  assert.match(harnessSource, /CodexSandboxUsers/);
  assert.match(harnessSource, /local Administrators/);
  assert.match(harnessSource, /Unregister-ScheduledTask/);
  assert.match(probeSource, /WindowsIdentity.*GetCurrent/);
  assert.match(probeSource, /denied_read/);
  assert.match(probeSource, /denied_write/);
  assert.match(probeSource, /test-minimal-clones\.mjs/);
  assert.match(probeSource, /process_profile_tools_exact/);
  assert.doesNotMatch(probeSource, /test-local-smoke\.mjs/);
  assert.match(processSmokeSource, /MCP_TEST_STATE_ROOT/);
  assert.match(processSmokeSource, /state_root_mode/);
  console.log("PASS mcp_execution_identity_proof validate_only_no_mutation=true s4u_local_only=true dedicated_nonadmin_guard=true host_only_denial=true process_tool_smoke=true production_tasks_untouched=true");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
