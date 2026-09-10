import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ProcessManager } from "../dist/lib/process-manager.js";
import { startStallWatchdog } from "../dist/lib/stall-watchdog.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readEvents = (path) => existsSync(path)
  ? readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  : [];


const waitForEvent = async (path, name, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readEvents(path).some((event) => event.event === name)) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${name}: ${path}`);
};
const temporary = mkdtempSync(join(tmpdir(), "mcp-stall-watchdog-"));

try {
  const syntheticLog = join(temporary, "synthetic-stall.jsonl");
  const synthetic = startStallWatchdog({
    transportLogPath: join(temporary, "transport.jsonl"),
    logPath: syntheticLog,
    heartbeatMs: 20,
    stallThresholdMs: 100,
    sampleIntervalMs: 40,
    maxBytes: 128 * 1024,
    backendGeneration: "watchdog-test-generation",
    runtimeIdentity: { instance_id: "watchdog-test", source_commit: "1".repeat(40) },
  });

  await waitForEvent(syntheticLog, "watchdog_started");
  await sleep(80);
  const blockedAt = performance.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
  const blockedMs = performance.now() - blockedAt;
  await sleep(180);
  await synthetic.close();

  const syntheticEvents = readEvents(syntheticLog);
  const stallEvents = syntheticEvents.filter((event) => event.event === "stall_begin" || event.event === "stall_sample");
  assert.ok(syntheticEvents.some((event) => event.event === "watchdog_started"), "watchdog did not persist startup identity");
  assert.ok(stallEvents.length > 0, JSON.stringify(syntheticEvents));
  assert.ok(syntheticEvents.some((event) => event.event === "stall_recovered"), "watchdog did not persist recovery boundary");
  assert.ok(stallEvents.some((event) => Number(event.main_heartbeat_gap_ms) >= 100), `synthetic main-thread block was not observed: ${JSON.stringify(stallEvents)}`);
  assert.ok(stallEvents.some((event) => Number(event.watchdog_tick_delay_ms) < 80), "watchdog thread did not remain independently scheduled");
  assert.ok(stallEvents.every((event) => Number.isFinite(Number(event.process_rss_bytes))), "RSS evidence missing");
  assert.ok(stallEvents.every((event) => Number.isFinite(Number(event.system_free_memory_pct))), "system memory evidence missing");
  assert.ok(stallEvents.every((event) => event.runtime_instance_id === "watchdog-test"), "runtime identity missing from stall evidence");

  const floodLog = join(temporary, "output-flood.jsonl");
  const flood = startStallWatchdog({
    transportLogPath: join(temporary, "transport-flood.jsonl"),
    logPath: floodLog,
    heartbeatMs: 25,
    stallThresholdMs: 750,
    sampleIntervalMs: 100,
    maxBytes: 128 * 1024,
  });
  const manager = new ProcessManager();
  let result = await manager.startWithWait(
    "$payload = 'X' * 200; 1..10000 | ForEach-Object { Write-Output (('WATCHDOG_FLOOD_{0}_{1}' -f $_,$payload)) }",
    undefined,
    "caller_stall_watchdog_flood",
    10_000,
  );
  const deadline = Date.now() + 10_000;
  while (result.running === true && Date.now() < deadline) {
    result = await manager.readWithWait(String(result.process_id), 32_000, 500);
  }
  assert.equal(result.running, false, JSON.stringify(result));
  await sleep(150);
  await flood.close();

  const floodEvents = readEvents(floodLog);
  const floodStalls = floodEvents.filter((event) => event.event === "stall_begin" || event.event === "stall_sample");
  assert.equal(floodStalls.length, 0, `bounded launcher output still starved the main loop: ${JSON.stringify(floodStalls)}`);

  console.log(JSON.stringify({
    ok: true,
    synthetic_block_ms: Number(blockedMs.toFixed(1)),
    synthetic_stall_samples: stallEvents.length,
    max_main_gap_ms: Math.max(...stallEvents.map((event) => Number(event.main_heartbeat_gap_ms))),
    max_watchdog_delay_ms: Math.max(...stallEvents.map((event) => Number(event.watchdog_tick_delay_ms))),
    output_flood_stall_samples: floodStalls.length,
  }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}


