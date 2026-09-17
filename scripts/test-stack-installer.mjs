import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const install = join(root, "scripts", "install-stack.ps1");
const installSource = readFileSync(install, "utf8");
const doctorSource = readFileSync(join(root, "scripts", "stack-doctor.ps1"), "utf8");
const start = readFileSync(join(root, "scripts", "start-stack.ps1"), "utf8");
const serverSource = readFileSync(join(root, "src", "server.ts"), "utf8");
const fileTransferSource = readFileSync(join(root, "src", "lib", "file-transfer.ts"), "utf8");
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
assert.deepEqual(processContract.map((tool) => tool.name).sort(), ['download_chatgpt_file','kill_process','read_output','start_process']);
assert.match(serverSource, /registerFileTransferTools\(server, callerId\)/);
assert.doesNotMatch(fileTransferSource, /FILE_TRANSFER_WIDGET_URI|mount_visual_proof_bridge|MCP_LIBRARY_SPOOL_BRIDGE/);
assert.match(fileTransferSource, /CHATGPT_ARTIFACT=/);
assert.match(fileTransferSource, /type: "image" as const/);
assert.match(fileTransferSource, /openai\/fileParams/);
assert.equal(caddySpec.version, '2.11.3');
assert.match(caddySpec.sha256, /^[0-9a-f]{64}$/);
assert.equal(busyContract.contract_version, 10);
assert.equal(busyContract.authority, "standalone_busy_coordinator");
const expectedBusyCommands = ["list", "sweep", "snapshot", "recover", "claim", "heartbeat", "release", "inspect"];
assert.deepEqual(busyContract.required_commands, expectedBusyCommands);
assert.deepEqual(busyContract.core_required_commands, expectedBusyCommands);
assert.equal(existsSync(join(root, "stack", "busy", "audit_wrapper.py")), false, "retired Busy audit wrapper must not ship");
assert.equal(existsSync(join(root, "stack", "busy", "busy.py")), false, "duplicate root Busy core must not ship");
assert.equal(existsSync(join(root, "stack", "busy", "python", "busy.py")), true, "canonical nested Busy core must ship");

const busyCmd = join(root, "stack", "busy", "busy-python.cmd");
const busyHelp = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", busyCmd, "--help"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(busyHelp.status, 0, busyHelp.stderr || busyHelp.stdout);
for (const command of expectedBusyCommands) assert.match(busyHelp.stdout, new RegExp(`\\b${command}\\b`));
for (const retired of ["contract", "audit", "log"]) assert.doesNotMatch(busyHelp.stdout, new RegExp(`\\b${retired}\\b`));
const retiredContract = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", busyCmd, "contract"], { cwd: root, encoding: "utf8" });
assert.notEqual(retiredContract.status, 0, "retired Busy contract subcommand must stay absent");
assert.match(installSource, /coordinator-contract\.json/);
assert.match(installSource, /busy-python\.cmd'\) --help/);
assert.doesNotMatch(installSource, /busy-python\.cmd'\) contract/);
assert.match(doctorSource, /coordinator-contract\.json/);
assert.match(doctorSource, /\$busyCmd --help/);
assert.doesNotMatch(doctorSource, /\$busyCmd contract/);
assert.match(installSource, /exactly four connector tools/);
assert.doesNotMatch(installSource, /exactly five connector tools/);
assert.match(doctorSource, /media_delivery/);
assert.match(doctorSource, /process-result inline images plus ordinary artifact resources/);
assert.doesNotMatch(doctorSource, /library_delivery/);

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
  assert.equal(plan.tool_count, 4);
  assert.equal(plan.media_delivery, 'process-result inline images plus ordinary artifact resources');
  assert.equal(plan.no_mutation, true);
  assert.equal(existsSync(installRoot), false, "-Plan must not create InstallRoot");
  assert.equal(existsSync(busyRoot), false, "-Plan must not create BusyRoot");
  assert.equal(existsSync(rulesRoot), false, "-Plan must not create RulesRoot");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("stack installer contract: PASS");
