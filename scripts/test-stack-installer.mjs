import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const install = join(root, "scripts", "install-stack.ps1");
const start = readFileSync(join(root, "scripts", "start-stack.ps1"), "utf8");
const serverSource = readFileSync(join(root, "src", "server.ts"), "utf8");
const processContract = JSON.parse(readFileSync(join(root, "config", "process-tool-contract.json"), "utf8"));
const caddySpec = JSON.parse(readFileSync(join(root, "stack", "caddy-package.json"), "utf8"));
const profile = JSON.parse(readFileSync(join(root, "stack", "plan-only-profile.json"), "utf8"));
const busyContract = JSON.parse(readFileSync(join(root, "stack", "busy", "coordinator-contract.json"), "utf8"));

assert.equal(profile.id, "plan-only");
assert.equal(profile.permissions.source_mutation, false);
assert.equal(profile.permissions.git_mutation, false);
assert.equal(profile.permissions.scheduler_mutation, false);
assert.equal(profile.permissions.busy_claim_or_release, false);
assert.ok(profile.permissions.write_artifacts.includes("plan.md"));
assert.match(start, /MCP_TOOL_PROFILE = 'process'/);
assert.match(start, /MCP_BACKEND_MODE = '1'/);
assert.match(start, /MCP_OWNER_AUTH_MODE = 'local-edge'/);
assert.deepEqual(processContract.map((tool) => tool.name).sort(), ['kill_process','read_output','start_process']);
assert.match(serverSource, /registerProcessLibraryUploadWidget\(server\)/);
assert.match(serverSource, /PROCESS_LIBRARY_UPLOAD_WIDGET_URI/);
assert.equal(caddySpec.version, '2.11.3');
assert.match(caddySpec.sha256, /^[0-9a-f]{64}$/);
assert.equal(busyContract.contract_version, 6);
assert.equal(busyContract.authority, "standalone_busy_coordinator");
assert.ok(busyContract.invariants.some((x) => x.includes("queue selection")));

const busyCmd = join(root, "stack", "busy", "busy-python.cmd");
const busy = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", busyCmd, "contract"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(busy.status, 0, busy.stderr || busy.stdout);
const liveContract = JSON.parse(busy.stdout.trim());
assert.equal(liveContract.contract_version, 6);
assert.equal(liveContract.authority, "standalone_busy_coordinator");

const temp = mkdtempSync(join(tmpdir(), "mcp-stack-plan-"));
const installRoot = join(temp, "install");
const busyRoot = join(temp, "busy");
const rulesRoot = join(temp, "rules");
try {
  const cp = spawnSync("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", install,
    "-PublicOrigin", "https://example.invalid",
    "-OwnerLogin", "owner@example.invalid",
    "-InstallRoot", installRoot,
    "-BusyRoot", busyRoot,
    "-RulesRoot", rulesRoot,
    "-Plan",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(cp.status, 0, cp.stderr || cp.stdout);
  const plan = JSON.parse(cp.stdout.trim());
  assert.equal(plan.ok, true);
  assert.equal(plan.plan_only, true);
  assert.equal(plan.topology, 'local-home-direct');
  assert.equal(plan.tool_count, 3);
  assert.equal(plan.library_delivery, 'metadata/resource widget');
  assert.equal(plan.no_mutation, true);
  assert.equal(existsSync(installRoot), false, "-Plan must not create InstallRoot");
  assert.equal(existsSync(busyRoot), false, "-Plan must not create BusyRoot");
  assert.equal(existsSync(rulesRoot), false, "-Plan must not create RulesRoot");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("stack installer contract: PASS");
