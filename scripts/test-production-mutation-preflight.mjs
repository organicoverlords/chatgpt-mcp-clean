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

const benign = await run("Write-Output '/etc/caddy/Caddyfile'; Write-Output 'http://127.0.0.1:3012/health'");
assert.equal(benign.exit_code, 0);
assert.match(benign.stdout, /Caddyfile/);
assert.match(benign.stdout, /3012/);

console.log("PASS production_mutation_preflight direct_serving_mutations_blocked=true offpath_reference_allowed=true");
