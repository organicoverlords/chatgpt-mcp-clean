import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/set-direct-clone-funnel.ps1");
const run = spawnSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
  "-InstanceId", "clone-a",
  "-Port", "55578",
  "-PublicOrigin", "https://mcp.example.ts.net/clone-a",
  "-PlanOnly",
], { cwd: resolve("."), encoding: "utf8", windowsHide: true });
assert.equal(run.status, 0, run.stderr);
const plan = JSON.parse(run.stdout.trim());
assert.equal(plan.version, 1);
assert.equal(plan.instance_id, "clone-a");
assert.equal(plan.port, 55578);
assert.deepEqual(plan.routes, [
  { public_path: "/clone-a", target: "http://127.0.0.1:55578" },
  { public_path: "/.well-known/oauth-authorization-server/clone-a", target: "http://127.0.0.1:55578/.well-known/oauth-authorization-server/clone-a" },
  { public_path: "/.well-known/oauth-protected-resource/clone-a/mcp", target: "http://127.0.0.1:55578/.well-known/oauth-protected-resource/clone-a/mcp" },
  { public_path: "/.well-known/openid-configuration/clone-a", target: "http://127.0.0.1:55578/.well-known/openid-configuration/clone-a" },
]);
assert.equal(plan.routes.some((route) => route.public_path === "/"), false, "direct clone promotion must never rewrite the root Funnel handler");

const source = readFileSync(script, "utf8");
assert.doesNotMatch(source, /funnel\s+reset/i, "direct clone promotion must never reset Funnel");

const invalid = spawnSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
  "-InstanceId", "clone-a",
  "-Port", "55578",
  "-PublicOrigin", "https://mcp.example.ts.net/",
  "-PlanOnly",
], { cwd: resolve("."), encoding: "utf8", windowsHide: true });
assert.notEqual(invalid.status, 0, "root origin must not be accepted as a direct clone route");

console.log("PASS direct_clone_funnel_contract routes=4 root_untouched=true funnel_reset_forbidden=true oauth_metadata=true");
