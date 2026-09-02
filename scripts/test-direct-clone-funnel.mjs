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
assert.equal(plan.version, 2);
assert.equal(plan.mode, "raw_tcp_tls_bridge");
assert.equal(plan.instance_id, "clone-a");
assert.equal(plan.clone_backend_port, 55578);
assert.equal(plan.front_door_port, 3003);
assert.equal(plan.bridge_port, 3443);
assert.equal(plan.tcp_forward, "127.0.0.1:3443");
assert.deepEqual(plan.static_route, { route: "clone-a", backend_port: 55578 });
assert.deepEqual(plan.public_paths, [
  "/clone-a/health",
  "/.well-known/oauth-authorization-server/clone-a",
  "/.well-known/oauth-protected-resource/clone-a/mcp",
  "/.well-known/openid-configuration/clone-a",
]);

const source = readFileSync(script, "utf8");
assert.match(source, /--tcp=443/, "clone promotion must use raw TCP Funnel mode");
assert.doesNotMatch(source, /--set-path=/, "production clone ingress must not use Tailscale HTTP path proxying");
const keepalive = readFileSync(resolve("keepalive.ps1"), "utf8");
assert.doesNotMatch(keepalive, /funnel\s+--yes\s+--bg\s+--https=443/i, "supervisor must not restore the known-bad HTTPS Funnel proxy mode");
assert.match(keepalive, /function\s+EnsureFunnelBridge/, "supervisor must own TLS bridge recovery");
assert.match(keepalive, /funnel\s+--yes\s+--bg\s+--tcp=443/, "supervisor must restore only raw TCP Funnel mode");

const invalid = spawnSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
  "-InstanceId", "clone-a",
  "-Port", "55578",
  "-PublicOrigin", "https://mcp.example.ts.net/",
  "-PlanOnly",
], { cwd: resolve("."), encoding: "utf8", windowsHide: true });
assert.notEqual(invalid.status, 0, "root origin must not be accepted as a clone route");

console.log("PASS raw_tcp_clone_ingress mode=raw_tcp_tls_bridge bridge=3443 frontdoor=3003 backend=55578 oauth_metadata=preserved");
