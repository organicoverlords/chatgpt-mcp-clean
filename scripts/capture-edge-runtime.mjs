import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node scripts/capture-edge-runtime.mjs [--input <local-key-value-snapshot>]");
  process.exit(2);
}

let inputPath;
const args = process.argv.slice(2);
while (args.length) {
  const flag = args.shift();
  const value = args.shift();
  if (!value) usage(`missing value for ${flag}`);
  if (flag === "--input") inputPath = value;
  else usage(`unknown argument: ${flag}`);
}

const required = new Set([
  "timestamp",
  "caddy_active",
  "caddy_pid",
  "caddy_fds",
  "caddy_rss_kb",
  "public_established",
  "public_timewait",
  "backend_established",
  "fallback_listener_count",
]);
const numeric = new Set([
  "caddy_pid",
  "caddy_fds",
  "caddy_rss_kb",
  "public_established",
  "public_timewait",
  "backend_established",
  "fallback_listener_count",
]);

function parseSnapshot(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("invalid runtime snapshot line");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!required.has(key)) throw new Error(`unexpected runtime snapshot field: ${key}`);
    if (values.has(key)) throw new Error(`duplicate runtime snapshot field: ${key}`);
    values.set(key, value);
  }
  for (const key of required) if (!values.has(key)) throw new Error(`missing runtime snapshot field: ${key}`);
  for (const key of numeric) {
    const value = Number(values.get(key));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid numeric runtime snapshot field: ${key}`);
    values.set(key, value);
  }
  const timestamp = values.get("timestamp");
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error("invalid runtime snapshot timestamp");
  const caddyState = values.get("caddy_active");
  if (!/^[a-z-]+$/.test(caddyState)) throw new Error("invalid caddy active state");
  return {
    timestamp: new Date(timestamp).toISOString(),
    caddy: {
      active: caddyState === "active",
      state: caddyState,
      pid: values.get("caddy_pid"),
      fd_count: values.get("caddy_fds"),
      rss_kb: values.get("caddy_rss_kb"),
    },
    sockets: {
      public_established: values.get("public_established"),
      public_timewait: values.get("public_timewait"),
      backend_established: values.get("backend_established"),
      fallback_listener_count: values.get("fallback_listener_count"),
    },
    privacy: { raw_remote_output_emitted: false },
  };
}

let raw;
if (inputPath) {
  if (!existsSync(inputPath)) usage(`input file does not exist: ${inputPath}`);
  raw = readFileSync(inputPath, "utf8");
} else {
  if (process.platform !== "win32") throw new Error("edge runtime capture currently requires the registered Windows edge control route");
  const ssh = "C:\\Program Files\\Git\\usr\\bin\\ssh.exe";
  const key = join(homedir(), ".ssh", "tietokettu_edge");
  if (!existsSync(ssh) || !existsSync(key)) throw new Error("registered edge SSH control route is unavailable");
  const remoteCommand = String.raw`set -eu
pid=$(systemctl show caddy -p MainPID --value)
printf 'timestamp='; date -u +%Y-%m-%dT%H:%M:%SZ
printf 'caddy_active='; systemctl is-active caddy
printf 'caddy_pid=%s\n' "$pid"
printf 'caddy_fds='; ls -1 /proc/$pid/fd | wc -l
printf 'caddy_rss_kb='; awk '/VmRSS:/{print $2}' /proc/$pid/status
printf 'public_established='; ss -Htn state established '( sport = :443 )' | wc -l
printf 'public_timewait='; ss -Htn state time-wait '( sport = :443 )' | wc -l
printf 'backend_established='; ss -Htn state established '( dst 10.203.0.2 dport = :3011 )' | wc -l
printf 'fallback_listener_count='; ss -H -ltn | awk '$4 ~ /:(3101|3102|3103|3104)$/ {c++} END{print c+0}'`;
  raw = execFileSync(ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-i", key, "root@5.61.91.127", remoteCommand], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64_000,
  });
}

console.log(JSON.stringify(parseSnapshot(raw), null, 2));
