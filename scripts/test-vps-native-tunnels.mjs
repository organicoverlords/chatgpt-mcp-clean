import assert from 'node:assert/strict';
import fs from 'node:fs';

const launcher = fs.readFileSync(new URL('./start-vps-native-tunnels.ps1', import.meta.url), 'utf8');
const caddy = fs.readFileSync(new URL('../config/vps-caddy-sharded.Caddyfile', import.meta.url), 'utf8');

for (const port of [3101, 3102, 3103, 3104]) {
  assert.match(launcher, new RegExp(`\\b${port}\\b`), `launcher must own lane ${port}`);
  assert.match(caddy, new RegExp(`127\\.0\\.0\\.1:${port}\\b`), `Caddy must route through lane ${port}`);
}
assert.match(launcher, /Git\\usr\\bin\\ssh\.exe/i, 'launcher must use native OpenSSH');
assert.match(launcher, /ExitOnForwardFailure=yes/);
assert.match(launcher, /ServerAliveInterval=15/);
assert.match(launcher, /ServerAliveCountMax=3/);
assert.doesNotMatch(launcher, /asyncssh|uv\.exe|vps_mcp_reverse_tunnel\.py/i, 'single AsyncSSH path must stay retired');
assert.match(caddy, /lb_policy round_robin/);
assert.match(caddy, /lb_try_duration 2s/);
assert.match(caddy, /health_uri \/health/);
assert.match(caddy, /max_fails 1/);
assert.doesNotMatch(caddy, /reverse_proxy\s+127\.0\.0\.1:3011(?:\s|$)/, 'Caddy must not collapse back to the single legacy tunnel');

console.log('vps-native-tunnel-contract: PASS');