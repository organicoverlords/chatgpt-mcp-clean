import assert from 'node:assert/strict';
import fs from 'node:fs';

const launcher = fs.readFileSync(new URL('./start-vps-native-tunnels.ps1', import.meta.url), 'utf8');
const caddy = fs.readFileSync(new URL('../config/vps-caddy-sharded.Caddyfile', import.meta.url), 'utf8');

for (const port of [3101, 3102, 3103, 3104]) {
  assert.match(launcher, new RegExp(`\\b${port}\\b`), `launcher must own fallback lane ${port}`);
  assert.match(caddy, new RegExp(`127\\.0\\.0\\.1:${port}\\b`), `Caddy must retain fallback lane ${port}`);
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
  ['10.203.0.2:3011', '127.0.0.1:3101', '127.0.0.1:3102', '127.0.0.1:3103', '127.0.0.1:3104'],
  'WireGuard must be first, with all four native SSH lanes retained as ordered fallback',
);
assert.match(caddy, /lb_policy first/);
assert.doesNotMatch(caddy, /lb_policy round_robin/);
assert.match(caddy, /lb_try_duration 2s/);
assert.match(caddy, /health_uri \/health/);
assert.match(caddy, /max_fails 1/);
assert.doesNotMatch(caddy, /reverse_proxy\s+127\.0\.0\.1:3011(?:\s|$)/, 'Caddy must not restore the retired single reverse-SSH ingress');

console.log('vps-wireguard-primary-contract: PASS');
