import assert from "node:assert/strict";

process.env.MCP_TEST_PREFLIGHT_DELAY_MS = "1200";
const { ProcessManager } = await import("../dist/lib/process-manager.js");
const manager = new ProcessManager({ maxLivePerCaller: 2, maxLiveTotal: 2 });
const payload = "A".repeat(100_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const request = manager.startStructuredWithWait(
  process.execPath,
  ["-e", "process.stdin.resume(); process.stdin.on('end',()=>console.log('PREFLIGHT_OK'))"],
  process.cwd(),
  "preflight-isolation",
  4_000,
  undefined,
  undefined,
  payload,
);

const timerAt = performance.now();
await sleep(75);
const timerMs = performance.now() - timerAt;
assert.ok(timerMs < 300, "large preflight blocked the main event loop: " + timerMs.toFixed(1) + "ms");

const result = await request;
assert.equal(result.running, false, JSON.stringify(result));
assert.match(String(result.stdout), /PREFLIGHT_OK/);
console.log(JSON.stringify({ ok: true, event_loop_timer_ms: Number(timerMs.toFixed(1)) }));
