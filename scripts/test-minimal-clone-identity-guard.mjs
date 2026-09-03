#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const temporary = mkdtempSync(join(tmpdir(), "minimal-clone-identity-"));
const stableStore = join(temporary, "clone-a", "oauth.json");
mkdirSync(join(temporary, "clone-a"), { recursive: true });
writeFileSync(stableStore, "{}", "utf8");
const script = resolve("scripts/start-minimal-clone.ps1");
function preflight(extra = []) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-InstanceId", "clone-a-next", "-Port", "3021", "-PublicOrigin", "https://example.test/clone-a", "-StateRoot", temporary, "-ValidateOnly", ...extra], { encoding: "utf8", windowsHide: true });
}
try {
  const missing = preflight();
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stdout}${missing.stderr}`, /must explicitly reuse the stable OAuth store/);
  const wrong = preflight(["-OAuthStorePath", join(temporary, "clone-a-next", "oauth.json")]);
  assert.notEqual(wrong.status, 0);
  assert.match(`${wrong.stdout}${wrong.stderr}`, /must be the stable 'clone-a' store/);
  const correct = preflight(["-OAuthStorePath", stableStore]);
  assert.equal(correct.status, 0, correct.stderr);
  assert.match(correct.stdout, /IDENTITY_PREFLIGHT_OK/);
  console.log("PASS minimal_clone_identity_guard unsafe_replacement_blocked=true wrong_store_blocked=true stable_store_required=true");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
