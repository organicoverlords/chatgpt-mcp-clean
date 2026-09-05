import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager();

function rejects(command) {
  assert.throws(
    () => manager.start(command, undefined, "caller_production_mutation_reject"),
    (error) => error instanceof Error
      && error.message.startsWith("start_process_preflight_failed:")
      && /direct MCP production ingress mutation/.test(error.message),
    `expected production mutation rejection: ${command}`,
  );
}

async function run(command) {
  const started = manager.start(command, undefined, "caller_production_mutation_allow");
  let result = started;
  for (let attempt = 0; attempt < 20 && result.running !== false; attempt += 1) {
    result = await manager.readWithWait(started.process_id, 32_000, 250);
  }
  return result;
}

rejects(`& ssh.exe root@5.61.91.127 "cp /tmp/Caddyfile /etc/caddy/Caddyfile; systemctl reload caddy"`);
rejects("netsh interface portproxy set v4tov4 listenaddress=10.203.0.2 listenport=3011 connectaddress=127.0.0.1 connectport=3003");
rejects("$h=Invoke-RestMethod http://127.0.0.1:3011/health; Stop-Process -Id $h.pid -Force");
rejects("$h=Invoke-RestMethod http://127.0.0.1:3003/health; taskkill.exe /PID $h.pid /T /F");
rejects("Stop-Service 'WireGuardTunnel$mcp-wireguard'");
rejects("Stop-ScheduledTask -TaskName 'McpV3Production3011'");
rejects("& 'C:\\Users\\Example\\ChatGPTMcpClean\\minimal-connectors\\cutover-production-20260905.ps1'");
rejects("& 'C:\\Users\\Example\\ChatGPTMcpClean\\scripts\\production-replacement-guardian.ps1'");
rejects("& 'C:\\Users\\Example\\ChatGPTMcpClean\\scripts\\production-replacement-candidate.ps1'");
rejects("uv run --with asyncssh python C:\\Users\\Example\\McpVpsEdge\\provision_edge_extras.py --caddy-only --backend-port 3012");
rejects("Start-ScheduledTask -TaskName 'McpV3ProductionReplacementGuardian'");
rejects("schtasks.exe /Run /TN McpV3ProductionReplacementCandidate");

const supportedLauncher = await run("if ($false) { & 'C:\\Users\\Example\\ChatGPTMcpClean\\scripts\\launch-production.ps1' }; Write-Output 'SUPPORTED_PRODUCTION_LAUNCHER_ALLOWED'");
assert.equal(supportedLauncher.exit_code, 0);
assert.match(supportedLauncher.stdout, /SUPPORTED_PRODUCTION_LAUNCHER_ALLOWED/);

const supportedReplacementRequest = await run("if ($false) { & 'C:\\Users\\Example\\ChatGPTMcpClean\\scripts\\replace-wireguard-production.ps1' }; Write-Output 'SUPPORTED_WIREGUARD_REPLACEMENT_REQUEST_ALLOWED'");
assert.equal(supportedReplacementRequest.exit_code, 0);
assert.match(supportedReplacementRequest.stdout, /SUPPORTED_WIREGUARD_REPLACEMENT_REQUEST_ALLOWED/);

const supportedReplacementInstaller = await run("if ($false) { & 'C:\\Users\\Example\\ChatGPTMcpClean\\scripts\\install-production-replacement-task.ps1' }; Write-Output 'SUPPORTED_REPLACEMENT_TASK_INSTALLER_ALLOWED'");
assert.equal(supportedReplacementInstaller.exit_code, 0);
assert.match(supportedReplacementInstaller.stdout, /SUPPORTED_REPLACEMENT_TASK_INSTALLER_ALLOWED/);


const renderOnlyEdgeOwner = await run("if ($false) { uv run --with asyncssh python C:\\Users\\Example\\McpVpsEdge\\provision_edge_extras.py --render-caddy --backend-port 3012 }; Write-Output 'EDGE_RENDER_ONLY_ALLOWED'");
assert.equal(renderOnlyEdgeOwner.exit_code, 0);
assert.match(renderOnlyEdgeOwner.stdout, /EDGE_RENDER_ONLY_ALLOWED/);

const benign = await run("Write-Output '/etc/caddy/Caddyfile'; Write-Output 'http://127.0.0.1:3012/health'");
assert.equal(benign.exit_code, 0);
assert.match(benign.stdout, /Caddyfile/);
assert.match(benign.stdout, /3012/);

console.log("PASS production_mutation_preflight direct_serving_mutations_blocked=true offpath_reference_allowed=true");
