#!/usr/bin/env node
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const temporary = mkdtempSync(join(tmpdir(), "mcp-execution-access-"));
const source = join(temporary, "source");
const runtime = join(temporary, "runtime");
const state = join(temporary, "state-not-created");
const replacement = join(temporary, "replacement-not-created");
mkdirSync(join(source, "scripts"), { recursive: true });
mkdirSync(runtime, { recursive: true });
writeFileSync(join(source, ".env"), "TAILSCALE_OWNER_LOGIN=test\n", "utf8");
const helper = resolve("scripts/provision-mcp-execution-access.ps1");
const oauthHelper = resolve("scripts/protect-oauth-state.ps1");
const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

try {
  const helperSource = readFileSync(helper, "utf8");
  assert.doesNotMatch(helperSource, /env:LOCALAPPDATA/, "identity ACL helper must use explicit paths, not the service profile");
  assert.match(helperSource, /protect-oauth-state\.ps1/);
  assert.match(helperSource, /Get-LocalGroupMember/);
  assert.match(helperSource, /CodexSandboxUsers/);
  assert.match(helperSource, /icacls\.exe/);

  const result = spawnSync(pwsh, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper,
    "-PrincipalUserId", "KONE\\McpServiceProof",
    "-SourceRoot", source,
    "-RuntimeRoot", runtime,
    "-StateRoot", state,
    "-ReplacementStateRoot", replacement,
    "-ValidateOnly",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const validated = JSON.parse(result.stdout.trim());
  assert.equal(validated.status, "MCP_EXECUTION_ACCESS_VALIDATED");
  assert.equal(validated.mutates_acl, false);
  assert.equal(validated.principal_user_id, "KONE\\McpServiceProof");
  assert.equal(validated.codex_sandbox_users_oauth_access, "excluded");
  assert.equal(validated.oauth_acl_owner, "scripts/protect-oauth-state.ps1");
  assert.equal(existsSync(state), false, "validate-only must not create state directories");
  assert.equal(existsSync(replacement), false, "validate-only must not create replacement directories");
  const rights = Object.fromEntries(validated.access_plan.map((entry) => [entry.purpose, entry.rights]));
  assert.equal(rights["source/scripts read+execute"], "RX");
  assert.equal(rights["replacement runtime git/dist mutation"], "M");
  assert.equal(rights["MCP state and shared receipts"], "M");
  assert.equal(rights["replacement request/receipt/rollback state"], "M");
  assert.equal(rights["explicit production environment file"], "R");

  const applyRoot = join(temporary, "apply");
  const applySource = join(applyRoot, "source");
  const applyRuntime = join(applyRoot, "runtime");
  const applyState = join(applyRoot, "state");
  const applyReplacement = join(applySource, ".state", "production-replacement");
  mkdirSync(join(applySource, "scripts"), { recursive: true });
  mkdirSync(applyRuntime, { recursive: true });
  writeFileSync(join(applySource, ".env"), "TAILSCALE_OWNER_LOGIN=test\n", "utf8");
  copyFileSync(oauthHelper, join(applySource, "scripts", "protect-oauth-state.ps1"));
  const appliedResult = spawnSync(pwsh, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper,
    "-PrincipalSid", "S-1-5-19",
    "-SourceRoot", applySource,
    "-RuntimeRoot", applyRuntime,
    "-StateRoot", applyState,
    "-ReplacementStateRoot", applyReplacement,
    "-Apply",
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(appliedResult.status, 0, `${appliedResult.stdout}\n${appliedResult.stderr}`);
  const applied = JSON.parse(appliedResult.stdout.trim());
  assert.equal(applied.status, "MCP_EXECUTION_ACCESS_PROVISIONED");
  assert.equal(applied.mutates_acl, true);
  assert.equal(applied.principal_sid, "S-1-5-19");
  assert.equal(applied.principal_explicit_local_admin, false);
  assert.equal(applied.principal_codex_sandbox_member, false);
  assert.equal(existsSync(applyState), true);
  assert.equal(existsSync(applyReplacement), true);
  const q = (value) => value.replaceAll("'", "''");
  const aclProbe = spawnSync(pwsh, [
    "-NoProfile", "-NonInteractive", "-Command",
    `$paths=@('${q(applySource)}','${q(applyRuntime)}','${q(applyState)}','${q(applyReplacement)}'); ` +
      `$rows=@($paths|ForEach-Object{$a=Get-Acl -LiteralPath $_; $r=@($a.Access|Where-Object{try{$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-19'}catch{$false}}); [pscustomobject]@{path=$_;rights=@($r|ForEach-Object{$_.FileSystemRights.ToString()})}}); $rows|ConvertTo-Json -Depth 4 -Compress`,
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(aclProbe.status, 0, `${aclProbe.stdout}\n${aclProbe.stderr}`);
  const aclRows = JSON.parse(aclProbe.stdout.trim());
  const rows = Array.isArray(aclRows) ? aclRows : [aclRows];
  const byPath = new Map(rows.map((row) => [row.path.toLowerCase(), row.rights.join("|")]));
  assert.match(byPath.get(applySource.toLowerCase()), /ReadAndExecute|FullControl|Modify/);
  assert.match(byPath.get(applyRuntime.toLowerCase()), /Modify|FullControl/);
  assert.match(byPath.get(applyState.toLowerCase()), /Modify|FullControl/);
  assert.match(byPath.get(applyReplacement.toLowerCase()), /Modify|FullControl/);

  console.log("PASS mcp_execution_access validate_only_no_mutation=true apply_offpath=true explicit_paths=true non_admin_guard=true least_rights_plan=true oauth_boundary_preserved=true");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
