import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "capture-edge-runtime-"));
const inputPath = join(temporary, "snapshot.txt");
const invalidPath = join(temporary, "invalid.txt");
const wrapper = fileURLToPath(new URL("./capture-edge-runtime.mjs", import.meta.url));
const fixture = [
  "timestamp=2026-09-05T12:00:00Z",
  "caddy_active=active",
  "caddy_pid=2242",
  "caddy_fds=108",
  "caddy_rss_kb=49180",
  "public_established=91",
  "public_timewait=0",
  "backend_established=6",
  "fallback_listener_count=4",
].join("\n") + "\n";

try {
  writeFileSync(inputPath, fixture, "utf8");
  const result = spawnSync(process.execPath, [wrapper, "--input", inputPath], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.timestamp, "2026-09-05T12:00:00.000Z");
  assert.deepEqual(report.caddy, { active: true, state: "active", pid: 2242, fd_count: 108, rss_kb: 49180 });
  assert.deepEqual(report.sockets, { public_established: 91, public_timewait: 0, backend_established: 6, fallback_listener_count: 4 });
  assert.equal(report.privacy.raw_remote_output_emitted, false);

  const secret = "secret-runtime-payload";
  writeFileSync(invalidPath, `${fixture}unexpected=${secret}\n`, "utf8");
  const invalid = spawnSync(process.execPath, [wrapper, "--input", invalidPath], { encoding: "utf8", windowsHide: true });
  assert.notEqual(invalid.status, 0);
  assert.ok(!invalid.stdout.includes(secret));
  assert.ok(!invalid.stderr.includes(secret));
  assert.match(invalid.stderr, /unexpected runtime snapshot field: unexpected/);
  console.log("PASS capture_edge_runtime fixed_fields=true aggregate_only=true unexpected_fields_fail_closed=true raw_remote_output_emitted=false");
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}
