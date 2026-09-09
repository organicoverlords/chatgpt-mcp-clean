#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const temporary = mkdtempSync(join(tmpdir(), "minimal-clone-identity-"));
const stableStore = join(temporary, "clone-a", "oauth.json");
mkdirSync(join(temporary, "clone-a"), { recursive: true });
writeFileSync(stableStore, "{}", "utf8");
const script = resolve("scripts/start-minimal-clone.ps1");
const scriptSource = readFileSync(script, "utf8");
assert.match(scriptSource, /canonicalStateRoot = \[IO\.Path\]::GetFullPath\(\(Join-Path \$Root 'minimal-connectors'\)\)/, "canonical state guard must follow the explicit repo root, not the runtime account profile");
function preflight(instanceId = "clone-a-next", extra = []) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-InstanceId", instanceId, "-Port", "3021", "-PublicOrigin", "https://example.test/clone-a", "-StateRoot", temporary, "-ValidateOnly", ...extra], { encoding: "utf8", windowsHide: true });
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
  console.log("PASS minimal_clone_identity_guard unsafe_replacement_blocked=true same_instance_wrong_store_blocked=true stable_store_required=true");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
