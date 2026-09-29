import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const installer = readFileSync(new URL("./install-vps-watchdog.ps1", import.meta.url), "utf8");
const receiverPath = new URL("../ops/vps-watchdog/receiver.py", import.meta.url);
const statusPath = new URL("../ops/vps-watchdog/status.py", import.meta.url);
const configPath = new URL("../ops/vps-watchdog/config.example.json", import.meta.url);

assert.match(installer, /new_daemon\s*=\s*\$false/);
assert.match(installer, /new_scanner\s*=\s*\$false/);
assert.match(installer, /command="\/opt\/v3-watchdog\/receiver\.py KONE"/);
assert.match(installer, /command="\/opt\/v3-watchdog\/receiver\.py OMEN"/);
assert.match(installer, /no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty,no-user-rc/);

const remoteMatch = /\$remote\s*=\s*@"([\s\S]*?)"@/m.exec(installer);
assert.ok(remoteMatch, "installer must have one bounded remote mutation block");
const remote = remoteMatch[1];
for (const forbidden of [
  "/etc/caddy",
  "systemctl",
  "ufw",
  "firewall",
  "WireGuard",
  "McpVpsEdgeTunnel",
  "caddy reload",
  "caddy restart",
  "3101",
  "3102",
  "3103",
  "3104",
]) {
  assert.equal(remote.includes(forbidden), false, `remote watchdog install must not touch ${forbidden}`);
}
for (const required of [
  "/opt/v3-watchdog",
  "/etc/v3-watchdog",
  "/var/lib/v3-watchdog",
  "/home/v3watchdog/.ssh/authorized_keys",
]) {
  assert.equal(remote.includes(required), true, `remote watchdog install must own ${required}`);
}

for (const path of [receiverPath, statusPath]) {
  const compiled = spawnSync("python", ["-m", "py_compile", path], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
}

const root = mkdtempSync(join(tmpdir(), "v3-watchdog-test-"));
const config = JSON.parse(readFileSync(configPath, "utf8"));
const testConfig = join(root, "config.json");
writeFileSync(testConfig, JSON.stringify(config));

const heartbeat = spawnSync("python", [receiverPath, "KONE"], {
  encoding: "utf8",
  env: {
    ...process.env,
    V3_WATCHDOG_STATE_DIR: root,
    SSH_ORIGINAL_COMMAND: "heartbeat",
  },
});
assert.equal(heartbeat.status, 0, heartbeat.stderr || heartbeat.stdout);
const koneBeat = JSON.parse(readFileSync(join(root, "kone.heartbeat.json"), "utf8"));
assert.equal(koneBeat.node, "KONE");

writeFileSync(join(root, "omen.heartbeat.json"), JSON.stringify({ node: "OMEN", received_at: Date.now() / 1000 }));
writeFileSync(join(root, "healthline.json"), JSON.stringify({
  received_at: Date.now() / 1000,
  payload: {
    current_nodes: {
      nodes: {
        "kone-gpu-desktop": {
          mem_available_gb: 2.5,
          disk_free_gb: 9.5,
          freshness: "FRESH",
          machine_state: "AVAILABLE",
          machine_reachability: "REACHABLE",
        },
        "omen-linux-laptop": {
          mem_available_gb: 8.0,
          disk_free_gb: 22.0,
          freshness: "FRESH",
          machine_state: "AVAILABLE",
          machine_reachability: "REACHABLE",
        },
      },
    },
  },
}));

const status = spawnSync("python", [statusPath], {
  encoding: "utf8",
  env: {
    ...process.env,
    V3_WATCHDOG_STATE_DIR: root,
    V3_WATCHDOG_CONFIG: testConfig,
  },
});
assert.equal(status.status, 0, status.stderr || status.stdout);
const parsed = JSON.parse(status.stdout);
assert.equal(parsed.schema, "v3-watchdog.status.v1");
assert.equal(parsed.nodes.KONE.resources.memory_available_gb, 2.5);
assert.equal(parsed.nodes.KONE.resources.disk_free_gb, 9.5);
assert.equal(parsed.nodes.OMEN.resources.memory_available_gb, 8.0);
assert.equal(parsed.nodes.OMEN.resources.disk_free_gb, 22.0);

console.log("PASS vps_watchdog bounded_receiver=true no_new_scanner=true existing_healthline_reused=true");
