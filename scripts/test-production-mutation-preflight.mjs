import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager();
const productionVpsIp = ["5", "61", "91", "127"].join(".");
const productionVpsHost = ["5-61-91-127", "sslip", "io"].join(".");
const wireGuardVpsIp = ["10", "203", "0", "1"].join(".");
const caddyPath = ["", "etc", "caddy", "Caddyfile"].join("/");


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
rejects(`& ssh.exe root@${productionVpsIp} "python3 -c 'print(1)'"`);
rejects(`scp.exe C:\tmp\Caddyfile root@${productionVpsIp}:${caddyPath}`);
rejects(`sftp.exe root@${productionVpsIp}`);
rejects(`rsync.exe C:\tmp\Caddyfile root@${productionVpsIp}:${caddyPath}`);
rejects(`plink.exe root@${productionVpsIp} -batch echo mutation-capable-raw-transport`);
rejects(`uv run --with asyncssh python -c "import asyncssh; print('${productionVpsIp}')"`);
rejects(`ssh root@${productionVpsHost} true`);
rejects(`& 'C:\Windows\System32\OpenSSH\ssh.exe' root@${productionVpsIp} true`);
rejects(`Start-Process -FilePath 'C:\Windows\System32\OpenSSH\ssh.exe' -ArgumentList 'root@${productionVpsIp}','true'`);
rejects(`ssh root@${wireGuardVpsIp} true`);
rejects(`cmd.exe /c "ssh root@${productionVpsIp} true"`);
rejects(`pwsh.exe -NoProfile -Command "scp C:\\tmp\\Caddyfile root@${productionVpsIp}:${caddyPath}"`);
rejects(`python -c "import paramiko; print('${productionVpsIp}')"`);
rejects("$env:PORT='3011'; node dist/index.js");
rejects("$env:FRONT_DOOR_PORT='3003'; node dist/front-door.js");
rejects("cmd.exe /c \"node dist/index.js\"");
rejects("Start-Process -FilePath node.exe -ArgumentList 'dist/front-door.js'");
rejects("& .\\scripts\\start-minimal-clone.ps1 -InstanceId clone-a -Port 3011 -PublicOrigin https://example.test");
rejects("netsh interface portproxy set v4tov4 listenaddress=10.203.0.2 listenport=3011 connectaddress=127.0.0.1 connectport=3003");
rejects("$h=Invoke-RestMethod http://127.0.0.1:3011/health; Stop-Process -Id $h.pid -Force");
rejects("$h=Invoke-RestMethod http://127.0.0.1:3003/health; taskkill.exe /PID $h.pid /T /F");
rejects("Stop-Service 'WireGuardTunnel$mcp-wireguard'");
rejects("Stop-ScheduledTask -TaskName 'McpV3Production3011'");
rejects("net.exe stop 'WireGuardTunnel$mcp-wireguard'");
rejects("Get-CimInstance Win32_Service -Filter 'Name=\"WireGuardTunnel$mcp-wireguard\"' | Invoke-CimMethod -MethodName StopService");
rejects("Set-ScheduledTask -TaskName 'McpV3Production3011' -Settings (New-ScheduledTaskSettingsSet)");
rejects("schtasks.exe /Create /TN McpV3Production3011 /TR calc.exe /SC ONCE /ST 23:59 /F");
rejects("Start-ScheduledTask -TaskName 'McpVpsEdgeTunnel'");
rejects("New-NetFirewallRule -DisplayName 'MCP test' -Direction Inbound -LocalAddress 10.203.0.2 -LocalPort 3011 -Action Block");
rejects("Remove-NetRoute -DestinationPrefix '10.203.0.2/32' -Confirm:$false");
rejects("Disable-NetAdapter -Name 'mcp-wireguard' -Confirm:$false");
rejects("Set-NetIPAddress -InterfaceAlias 'mcp-wireguard' -IPAddress 10.203.0.2 -PrefixLength 30");
rejects("& 'C:\\Users\\Example\\ChatGPTMcpClean\\minimal-connectors\\cutover-production-20260905.ps1'");
rejects("& 'C:\\Users\\Example\\ChatGPTMcpClean\\scripts\\production-replacement-guardian.ps1'");
rejects("& 'C:\\Users\\Example\\ChatGPTMcpClean\\scripts\\production-replacement-candidate.ps1'");
rejects("uv run --with asyncssh python C:\\Users\\Example\\McpVpsEdge\\provision_edge_extras.py --caddy-only --backend-port 3012");
rejects("Start-ScheduledTask -TaskName 'McpV3ProductionReplacementGuardian'");
rejects("schtasks.exe /Run /TN McpV3ProductionReplacementCandidate");

const guardianSourcePath = "C:\\Users\\Example\\ChatGPTMcpClean\\scripts\\production-replacement-guardian.ps1";
const candidateSourcePath = "C:\\Users\\Example\\ChatGPTMcpClean\\scripts\\production-replacement-candidate.ps1";
rejects(`pwsh.exe -NoLogo -NoProfile -File '${guardianSourcePath}'`);
rejects(guardianSourcePath);
rejects(`powershell.exe -NoProfile '${guardianSourcePath}'`);
rejects(`. '${candidateSourcePath}'`);

const sourceReference = await run(`Write-Output '${guardianSourcePath}'; Write-Output 'SOURCE_REFERENCE_ALLOWED'`);
assert.equal(sourceReference.exit_code, 0);
assert.match(sourceReference.stdout, /SOURCE_REFERENCE_ALLOWED/);

const sourceRead = await run(`if ($false) { Get-Content -LiteralPath '${guardianSourcePath}' }; Write-Output 'SOURCE_READ_ALLOWED'`);
assert.equal(sourceRead.exit_code, 0);
assert.match(sourceRead.stdout, /SOURCE_READ_ALLOWED/);

const sourceEditShape = await run(`if ($false) { Set-Content -LiteralPath '${candidateSourcePath}' -Value 'source-only' }; Write-Output 'SOURCE_EDIT_SHAPE_ALLOWED'`);
assert.equal(sourceEditShape.exit_code, 0);
assert.match(sourceEditShape.stdout, /SOURCE_EDIT_SHAPE_ALLOWED/);

const supportedLauncher = await run("if ($false) { & 'C:\\Users\\Example\\ChatGPTMcpClean\\scripts\\launch-production.ps1' }; Write-Output 'SUPPORTED_PRODUCTION_LAUNCHER_ALLOWED'");
assert.equal(supportedLauncher.exit_code, 0);
assert.match(supportedLauncher.stdout, /SUPPORTED_PRODUCTION_LAUNCHER_ALLOWED/);

const supportedOffpathProof = await run("if ($false) { node scripts/prove-offpath-backend-replacement.mjs }; Write-Output 'SUPPORTED_OFFPATH_PROOF_ALLOWED'");
assert.equal(supportedOffpathProof.exit_code, 0);
assert.match(supportedOffpathProof.stdout, /SUPPORTED_OFFPATH_PROOF_ALLOWED/);

const cloneIdentityValidation = await run("if ($false) { & .\\scripts\\start-minimal-clone.ps1 -InstanceId clone-a -Port 3011 -PublicOrigin https://example.test -ValidateOnly }; Write-Output 'CLONE_IDENTITY_VALIDATION_ALLOWED'");
assert.equal(cloneIdentityValidation.exit_code, 0);
assert.match(cloneIdentityValidation.stdout, /CLONE_IDENTITY_VALIDATION_ALLOWED/);

const supportedReplacementRequest = await run("if ($false) { & 'C:\\Users\\Example\\ChatGPTMcpClean\\scripts\\replace-wireguard-production.ps1' }; Write-Output 'SUPPORTED_WIREGUARD_REPLACEMENT_REQUEST_ALLOWED'");
assert.equal(supportedReplacementRequest.exit_code, 0);
assert.match(supportedReplacementRequest.stdout, /SUPPORTED_WIREGUARD_REPLACEMENT_REQUEST_ALLOWED/);

const supportedReplacementInstaller = await run("if ($false) { & 'C:\\Users\\Example\\ChatGPTMcpClean\\scripts\\install-production-replacement-task.ps1' }; Write-Output 'SUPPORTED_REPLACEMENT_TASK_INSTALLER_ALLOWED'");
assert.equal(supportedReplacementInstaller.exit_code, 0);
assert.match(supportedReplacementInstaller.stdout, /SUPPORTED_REPLACEMENT_TASK_INSTALLER_ALLOWED/);
const supportedEdgeSnapshot = await run("if ($false) { node scripts/capture-edge-runtime.mjs }; Write-Output 'SUPPORTED_EDGE_SNAPSHOT_ALLOWED'");
assert.equal(supportedEdgeSnapshot.exit_code, 0);
assert.match(supportedEdgeSnapshot.stdout, /SUPPORTED_EDGE_SNAPSHOT_ALLOWED/);

const supportedEdgeFanout = await run("if ($false) { node scripts/capture-edge-fanout.mjs --since 2026-09-06T00:00:00Z }; Write-Output 'SUPPORTED_EDGE_FANOUT_ALLOWED'");
assert.equal(supportedEdgeFanout.exit_code, 0);
assert.match(supportedEdgeFanout.stdout, /SUPPORTED_EDGE_FANOUT_ALLOWED/);

const supportedEdgeCorrelation = await run("if ($false) { node scripts/capture-edge-backend-correlation.mjs --since 2026-09-06T00:00:00Z }; Write-Output 'SUPPORTED_EDGE_CORRELATION_ALLOWED'");
assert.equal(supportedEdgeCorrelation.exit_code, 0);
assert.match(supportedEdgeCorrelation.stdout, /SUPPORTED_EDGE_CORRELATION_ALLOWED/);



const renderOnlyEdgeOwner = await run("if ($false) { uv run --with asyncssh python C:\\Users\\Example\\McpVpsEdge\\provision_edge_extras.py --render-caddy --backend-port 3012 }; Write-Output 'EDGE_RENDER_ONLY_ALLOWED'");
assert.equal(renderOnlyEdgeOwner.exit_code, 0);
assert.match(renderOnlyEdgeOwner.stdout, /EDGE_RENDER_ONLY_ALLOWED/);

const unrelatedServiceControl = await run("if ($false) { Stop-Service 'Spooler' }; Write-Output 'UNRELATED_SERVICE_CONTROL_ALLOWED'");
assert.equal(unrelatedServiceControl.exit_code, 0);
assert.match(unrelatedServiceControl.stdout, /UNRELATED_SERVICE_CONTROL_ALLOWED/);

const unrelatedTaskControl = await run("if ($false) { Set-ScheduledTask -TaskName 'UnrelatedTask' -Settings (New-ScheduledTaskSettingsSet) }; Write-Output 'UNRELATED_TASK_CONTROL_ALLOWED'");
assert.equal(unrelatedTaskControl.exit_code, 0);
assert.match(unrelatedTaskControl.stdout, /UNRELATED_TASK_CONTROL_ALLOWED/);

const unrelatedAdapterControl = await run("if ($false) { Disable-NetAdapter -Name 'Ethernet' -Confirm:$false }; Write-Output 'UNRELATED_ADAPTER_CONTROL_ALLOWED'");
assert.equal(unrelatedAdapterControl.exit_code, 0);
assert.match(unrelatedAdapterControl.stdout, /UNRELATED_ADAPTER_CONTROL_ALLOWED/);

const benignTransportReference = await run(`Get-Command ssh.exe -ErrorAction SilentlyContinue | Out-Null; Write-Output 'https://${productionVpsHost}/health'; Write-Output 'BENIGN_TRANSPORT_REFERENCE_ALLOWED'`);
assert.equal(benignTransportReference.exit_code, 0);
assert.match(benignTransportReference.stdout, /BENIGN_TRANSPORT_REFERENCE_ALLOWED/);

const publicHealthReference = await run(`if ($false) { Invoke-RestMethod https://${productionVpsHost}/health }; Write-Output 'PUBLIC_HEALTH_REFERENCE_ALLOWED'`);
assert.equal(publicHealthReference.exit_code, 0);
assert.match(publicHealthReference.stdout, /PUBLIC_HEALTH_REFERENCE_ALLOWED/);

const benign = await run("Write-Output '/etc/caddy/Caddyfile'; Write-Output 'http://127.0.0.1:3012/health'");
assert.equal(benign.exit_code, 0);
assert.match(benign.stdout, /Caddyfile/);
assert.match(benign.stdout, /3012/);

console.log("PASS production_mutation_preflight direct_serving_mutations_blocked=true raw_production_vps_transport_blocked=true windows_production_controls_blocked=true direct_serving_starts_blocked=true supported_edge_wrappers_allowed=true offpath_reference_allowed=true");
