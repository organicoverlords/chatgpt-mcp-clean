#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const temporary = mkdtempSync(join(tmpdir(), "minimal-clone-identity-"));
const stableStore = join(temporary, "clone-a", "oauth.json");
mkdirSync(join(temporary, "clone-a"), { recursive: true });
writeFileSync(stableStore, "{}", "utf8");
const script = resolve("scripts/start-minimal-clone.ps1");
function preflight(instanceId = "clone-a-next", extra = []) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-InstanceId", instanceId, "-Port", "3021", "-PublicOrigin", "https://example.test/clone-a", "-StateRoot", temporary, "-ValidateOnly", ...extra], { encoding: "utf8", windowsHide: true });
}
const powershell = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
const aclShell = "pwsh.exe";
const sandboxSid = "S-1-5-32-545";
const inspectAclCommand = String.raw`
$ErrorActionPreference='Stop'
$target=$env:MCP_ACL_TARGET
$identity=[Security.Principal.SecurityIdentifier]::new($env:MCP_ACL_SID)
$acl=Get-Acl -LiteralPath $target
$rules=@()
foreach($rule in @($acl.Access)) {
  try { $ruleSid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]) } catch { continue }
  if($ruleSid.Value -eq $identity.Value) { $rules += $rule }
}
$bad=@()
foreach($rule in $rules) {
  if(
    (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -ne 0) -or
    (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Delete) -ne 0) -or
    (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles) -ne 0) -or
    (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ChangePermissions) -ne 0) -or
    (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::TakeOwnership) -ne 0)
  ) { $bad += $rule }
}
[pscustomobject]@{
  protected=[bool]$acl.AreAccessRulesProtected
  matching=$rules.Count
  dangerous=$bad.Count
  all_inherited=(@($rules | Where-Object {-not $_.IsInherited}).Count -eq 0)
  rights=@($rules | ForEach-Object {$_.FileSystemRights.ToString()})
} | ConvertTo-Json -Compress
`;
function aclEnv(path) {
  return { ...process.env, MCP_ACL_TARGET: path, MCP_ACL_SID: sandboxSid };
}
function inspectAcl(path) {
  const result = spawnSync(aclShell, [...powershell, "-Command", inspectAclCommand], { encoding: "utf8", windowsHide: true, env: aclEnv(path) });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
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

  const aclDirectory = join(temporary, "oauth-acl");
  const aclStore = join(aclDirectory, "oauth.json");
  mkdirSync(aclDirectory, { recursive: true });
  writeFileSync(aclStore, "{}", "utf8");
  const seeded = spawnSync("icacls.exe", [aclDirectory, "/grant", `*${sandboxSid}:(OI)(CI)M`], { encoding: "utf8", windowsHide: true });
  assert.equal(seeded.status, 0, seeded.stderr);
  const seededAcl = inspectAcl(aclDirectory);
  assert.ok(seededAcl.dangerous > 0, `test setup must grant a write-capable sandbox ACE: ${JSON.stringify(seededAcl)}`);

  const aclScript = resolve("scripts/protect-oauth-state.ps1");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const hardened = spawnSync(aclShell, [...powershell, "-File", aclScript, "-OAuthStorePath", aclStore, "-SandboxIdentity", sandboxSid], { encoding: "utf8", windowsHide: true });
    assert.equal(hardened.status, 0, hardened.stderr);
    assert.match(hardened.stdout, /OAUTH_STATE_ACL_HARDENED/);
  }
  const hardenedDirectory = inspectAcl(aclDirectory);
  assert.equal(hardenedDirectory.protected, true);
  assert.equal(hardenedDirectory.matching, 1);
  assert.equal(hardenedDirectory.dangerous, 0);

  writeFileSync(`${aclStore}.next`, "{\"generation\":2}", "utf8");
  renameSync(`${aclStore}.next`, aclStore);
  const rewrittenStore = inspectAcl(aclStore);
  assert.equal(rewrittenStore.matching, 1);
  assert.equal(rewrittenStore.dangerous, 0);
  assert.equal(rewrittenStore.all_inherited, true);

  console.log("PASS minimal_clone_identity_guard unsafe_replacement_blocked=true same_instance_wrong_store_blocked=true stable_store_required=true oauth_acl_write_removed=true oauth_acl_rename_stable=true");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
