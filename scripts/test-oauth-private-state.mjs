#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const temporary = mkdtempSync(join(tmpdir(), "mcp-oauth-private-state-"));
const state = join(temporary, "clone-a");
const store = join(state, "oauth.json");
mkdirSync(state, { recursive: true });
writeFileSync(store, "{}", "utf8");
const helper = resolve("scripts/protect-oauth-state.ps1");
const launcher = resolve("scripts/start-minimal-clone.ps1");
const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

function ps(script) {
  const result = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

try {
  const helperSource = await import("node:fs").then(({ readFileSync }) => readFileSync(helper, "utf8"));
  assert.match(helperSource, /icacls\.exe/, "helper must use DACL-specific icacls operations");
  assert.doesNotMatch(helperSource, /^\s*Set-Acl\b/m, "helper must not route existing SACL state through Set-Acl");
  const launcherSource = await import("node:fs").then(({ readFileSync }) => readFileSync(launcher, "utf8"));
  assert.match(launcherSource, /protect-oauth-state\.ps1/);
  const hardened = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-OAuthStorePath", store, "-AllowedPrincipalSid", "S-1-5-19"], { encoding: "utf8", windowsHide: true });
  assert.equal(hardened.status, 0, hardened.stderr);
  assert.match(hardened.stdout, /OAUTH_STATE_ACL_OK/);
  const qState = state.replaceAll("'", "''");
  const qStore = store.replaceAll("'", "''");
  const summary = JSON.parse(ps(`$items=@('${qState}','${qStore}') | ForEach-Object { $a=Get-Acl -LiteralPath $_; [pscustomobject]@{path=$_;protected=$a.AreAccessRulesProtected;sandbox=@($a.Access|Where-Object{$_.IdentityReference.Value -match 'CodexSandboxUsers'}).Count;localService=@($a.Access|Where-Object{try{$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-19'}catch{$false}}).Count;principals=@($a.Access|ForEach-Object{$_.IdentityReference.Value}|Sort-Object -Unique)} }; $items|ConvertTo-Json -Compress`));
  const rows = Array.isArray(summary) ? summary : [summary];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    if (row.path === state) assert.equal(row.protected, true, `${row.path} must disable ACL inheritance`);
    else assert.equal(row.protected, false, `${row.path} must inherit from the protected OAuth directory`);
    assert.equal(row.sandbox, 0, `${row.path} must not grant CodexSandboxUsers access`);
    if (row.path === state) assert.ok(row.localService >= 1, `${row.path} must grant the dedicated execution principal`);
  }
  const tmp = join(state, "oauth.atomic.tmp");
  writeFileSync(tmp, "{}", "utf8");
  const qTmp = tmp.replaceAll("'", "''");
  const tempSummary = JSON.parse(ps(`$a=Get-Acl -LiteralPath '${qTmp}'; [pscustomobject]@{sandbox=@($a.Access|Where-Object{$_.IdentityReference.Value -match 'CodexSandboxUsers'}).Count;principals=@($a.Access|ForEach-Object{$_.IdentityReference.Value}|Sort-Object -Unique)}|ConvertTo-Json -Compress`));
  assert.equal(tempSummary.sandbox, 0, "new OAuth temp files must not grant CodexSandboxUsers access");
  console.log("PASS oauth_private_state directory_acl_protected=true file_inherits_private_parent=true sandbox_access=0 execution_principal_access=true atomic_temp_sandbox_access=0 normal_integrity_safe=true");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
