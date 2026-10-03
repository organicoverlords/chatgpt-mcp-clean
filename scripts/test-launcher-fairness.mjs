import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MCP_TEST_LAUNCH_DELAY_MS = "2500";
process.env.MCP_TEST_LAUNCH_DELAY_MATCH = "STALL_LAUNCH_A";
process.env.MCP_TEST_OUTPUT_SPOOL_DELAY_MS = "150";
process.env.MCP_TEST_OUTPUT_SPOOL_DELAY_MATCH = "STALL_SPOOL_A";

const { ProcessManager } = await import("../dist/lib/process-manager.js");
const receipts = await mkdtemp(join(tmpdir(), "mcp-launcher-fairness-"));
const manager = new ProcessManager({ maxLivePerCaller: 6, maxLiveTotal: 6, receiptDirectory: receipts });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForStarted(id, timeoutMs = 1500) {
  const started = performance.now();
  for (;;) {
    const value = manager.read(id);
    if (Number(value.pid) > 0) return performance.now() - started;
    if (performance.now() - started > timeoutMs) throw new Error("process did not start within bound: " + JSON.stringify(value));
    await sleep(20);
  }
}

async function waitForDone(id, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = manager.read(id);
    if (value.running === false) return value;
    if (Date.now() > deadline) throw new Error("process did not finish: " + JSON.stringify(value));
    await sleep(25);
  }
}

try {
  const slow = manager.startStructured(process.execPath, ["-e", "console.log('STALL_LAUNCH_A')"], undefined, "fairness-a");
  const fastAt = performance.now();
  const fast = manager.startStructured(process.execPath, ["-e", "console.log('FAIR_FAST_B')"], undefined, "fairness-b");
  const fastStartMs = await waitForStarted(fast.process_id);
  assert.ok(fastStartMs < 1000, "unrelated launch starved behind slow spawn: " + fastStartMs.toFixed(1) + "ms");
  const fastDone = await waitForDone(fast.process_id);
  assert.equal(fastDone.exit_code, 0);
  assert.ok(performance.now() - fastAt < 2000, "fast launch completion inherited slow launch delay");
  await waitForDone(slow.process_id);

  const floodCode = [
    "let i=0;",
    "const t=setInterval(() => {",
    "process.stdout.write('STALL_SPOOL_A:' + 'x'.repeat(8192) + '\\n');",
    "if (++i >= 20) { clearInterval(t); setTimeout(()=>process.exit(0), 50); }",
    "}, 10);",
  ].join("");
  const flood = manager.startStructured(process.execPath, ["-e", floodCode], undefined, "fairness-c");
  await waitForStarted(flood.process_id);
  await sleep(80);
  const peer = manager.startStructured(process.execPath, ["-e", "console.log('FAIR_SPOOL_PEER')"], undefined, "fairness-d");
  const peerStartMs = await waitForStarted(peer.process_id);
  assert.ok(peerStartMs < 1000, "unrelated launch starved behind synchronous spool: " + peerStartMs.toFixed(1) + "ms");
  const peerDone = await waitForDone(peer.process_id);
  assert.equal(peerDone.exit_code, 0);
  await waitForDone(flood.process_id, 15000);

  console.log(JSON.stringify({ ok: true, fast_start_ms: Number(fastStartMs.toFixed(1)), spool_peer_start_ms: Number(peerStartMs.toFixed(1)) }));
  process.exitCode = 0;
} finally {
  await rm(receipts, { recursive: true, force: true });
}
process.exit(0);
