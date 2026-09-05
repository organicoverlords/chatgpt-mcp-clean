import assert from 'node:assert/strict';
import fs from 'node:fs';

const launcher = fs.readFileSync(new URL('./start-vps-native-tunnels.ps1', import.meta.url), 'utf8');
const caddy = fs.readFileSync(new URL('../config/vps-caddy-sharded.Caddyfile', import.meta.url), 'utf8');

for (const port of [3101, 3102, 3103, 3104]) {
  assert.match(launcher, new RegExp(`\\b${port}\\b`), `launcher must own fallback lane ${port}`);
  assert.doesNotMatch(caddy, new RegExp(`127\\.0\\.0\\.1:${port}\\b`), `Caddy must not automatically route public MCP traffic through fallback lane ${port}`);
}
assert.match(launcher, /Git\\usr\\bin\\ssh\.exe/i, 'fallback launcher must use native OpenSSH');
assert.match(launcher, /ExitOnForwardFailure=yes/);
assert.match(launcher, /ServerAliveInterval=15/);
assert.match(launcher, /ServerAliveCountMax=3/);
assert.doesNotMatch(launcher, /asyncssh|uv\.exe|vps_mcp_reverse_tunnel\.py/i, 'single Python tunnel must stay retired');

const proxy = caddy.match(/reverse_proxy\s+([^\n{]+)\s*\{/);
assert.ok(proxy, 'Caddy reverse_proxy upstream list must exist');
assert.deepEqual(
  proxy[1].trim().split(/\s+/),
  ['10.203.0.2:3011'],
  'public MCP routing must stay pinned to the WireGuard upstream',
);
assert.match(caddy, /timeouts\s*\{[\s\S]*idle 15s/, 'public client idle connections must be reaped after 15s');
assert.match(caddy, /transport\s+http\s*\{[\s\S]*keepalive 30s[\s\S]*keepalive_idle_conns_per_host 4/, 'Caddy upstream idle pool must be time-bounded and capped per host');
const activeHealthDirective = /\bhealth_(?:uri|interval|timeout)\b/;
for (const directive of ['health_uri /health', 'health_interval 5s', 'health_timeout 2s']) {
  assert.throws(() => assert.doesNotMatch(`${caddy}\n${directive}`, activeHealthDirective),
    assert.AssertionError, `health polling guard must reject ${directive}`);
}
assert.doesNotMatch(caddy, activeHealthDirective, 'Caddy must not restore active upstream health polling');
assert.doesNotMatch(caddy, /reverse_proxy\s+127\.0\.0\.1:3011(?:\s|$)/, 'Caddy must not restore the retired single reverse-SSH ingress');

console.log('vps-wireguard-primary-contract: PASS');
