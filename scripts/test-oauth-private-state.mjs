#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const temporary = mkdtempSync(join(tmpdir(), "mcp-oauth-private-state-"));
const state = join(temporary, "clone-a");
const store = join(state, "oauth.json");
mkdirSync(state, { recursive: true });
const durableState = {
  clients: { "client-1": { client_id: "client-1", redirect_uris: ["https://chatgpt.com/connector/oauth/callback"], token_endpoint_auth_method: "none" } },
  access: {},
  refresh: { "refresh-digest": { clientId: "client-1", scopes: ["mcp"], resource: "https://example.test/", expiresAt: Date.now() + 86400000, subject: "owner@example.com" } },
  codes: {},
};
writeFileSync(store, JSON.stringify(durableState, null, 2), "utf8");
const helper = resolve("scripts/protect-oauth-state.ps1");
const launcher = resolve("scripts/start-minimal-clone.ps1");
const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

function ps(script) {
  const result = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
function runHelper(path, ...extra) {
  return spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-OAuthStorePath", path, ...extra], { encoding: "utf8", windowsHide: true });
}
function runRequiredPreflight(path) {
  return spawnSync(pwsh, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcher,
    "-InstanceId", "oauth-reboot-proof", "-Port", "3901", "-PublicOrigin", "https://example.test",
    "-StateRoot", temporary, "-OAuthStorePath", path, "-RequireExistingOAuthState", "-ValidateOnly",
  ], { encoding: "utf8", windowsHide: true });
}

try {
  const helperSource = readFileSync(helper, "utf8");
  assert.match(helperSource, /icacls\.exe/, "helper must use DACL-specific icacls operations");
  assert.doesNotMatch(helperSource, /^\s*Set-Acl\b/m, "helper must not route existing SACL state through Set-Acl");
  assert.match(helperSource, /VerifyOnly/);
  assert.match(helperSource, /RequireExistingState/);
  const launcherSource = readFileSync(launcher, "utf8");
  assert.match(launcherSource, /protect-oauth-state\.ps1/);
  assert.match(launcherSource, /RequireExistingOAuthState/);

  const hardened = runHelper(store, "-AllowedPrincipalSid", "S-1-5-19");
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

  // Production scheduled tasks run as the interactive owner, so normalize the same
  // fixture back to the exact production ACL set before testing reboot preflight.
  const productionHardened = runHelper(store);
  assert.equal(productionHardened.status, 0, productionHardened.stderr);
  const beforeVerify = readFileSync(store);
  const verified = runHelper(store, "-VerifyOnly", "-RequireExistingState");
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /mode=verify-only/);
  assert.deepEqual(readFileSync(store), beforeVerify, "verify-only must not rewrite OAuth bytes");

  const launcherVerified = runRequiredPreflight(store);
  assert.equal(launcherVerified.status, 0, `${launcherVerified.stdout}\n${launcherVerified.stderr}`);
  assert.match(launcherVerified.stdout, /IDENTITY_PREFLIGHT_OK/);
  assert.deepEqual(readFileSync(store), beforeVerify, "launcher preflight must not rewrite OAuth bytes");

  const missing = join(temporary, "missing", "oauth.json");
  const missingResult = runRequiredPreflight(missing);
  assert.notEqual(missingResult.status, 0);
  assert.match(`${missingResult.stdout}${missingResult.stderr}`, /required OAuth store does not exist/);

  writeFileSync(store, "{broken", "utf8");
  const corrupt = runRequiredPreflight(store);
  assert.notEqual(corrupt.status, 0);
  assert.match(`${corrupt.stdout}${corrupt.stderr}`, /not valid JSON/);

  writeFileSync(store, JSON.stringify({ clients: {}, access: {}, refresh: {}, codes: {} }), "utf8");
  const empty = runRequiredPreflight(store);
  assert.notEqual(empty.status, 0);
  assert.match(`${empty.stdout}${empty.stderr}`, /no durable client\/refresh state/);

  writeFileSync(store, beforeVerify);
  const rehard = runHelper(store);
  assert.equal(rehard.status, 0, rehard.stderr);
  const breakInheritance = spawnSync("icacls.exe", [store, "/inheritance:d"], { encoding: "utf8", windowsHide: true });
  assert.equal(breakInheritance.status, 0, breakInheritance.stderr);
  const wrongAcl = runHelper(store, "-VerifyOnly", "-RequireExistingState");
  assert.notEqual(wrongAcl.status, 0);
  assert.match(`${wrongAcl.stdout}${wrongAcl.stderr}`, /must inherit from the protected private directory/);

  console.log("PASS oauth_private_state directory_acl_protected=true file_inherits_private_parent=true sandbox_access=0 execution_principal_access=true atomic_temp_sandbox_access=0 normal_integrity_safe=true reboot_missing_blocked=true reboot_corrupt_blocked=true reboot_empty_blocked=true reboot_acl_drift_blocked=true verify_only_bytes_unchanged=true");
} finally {
  // The ACL-drift case intentionally disables file inheritance; normalize the temp
  // fixture before deleting it so cleanup does not depend on Windows delete semantics.
  if (readFileSync) {
    spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-OAuthStorePath", store], { encoding: "utf8", windowsHide: true });
  }
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
