import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

process.env.MCP_TOOL_PROFILE = "process";
process.env.MCP_DEFAULT_EXECUTION_TARGET = "local";
process.env.MCP_PROCESS_RECEIPT_DIR = resolve(".state/omen-routing-safety-receipts");
process.env.MCP_OMEN_EXEC_PATH = resolve(".state/legacy-omen-adapter-should-not-run.py");
delete process.env.MCP_OMEN_MCP_URL;
delete process.env.MCP_ALLOW_OMEN_SSH_FALLBACK;

const { createServer } = await import("../dist/server.js");
const server = createServer("omen-routing-safety");
const start = server._registeredTools.start_process;
assert.ok(start, "start_process missing");

await assert.rejects(
  () => start.handler({ execution_target: "omen", executable: process.execPath, args: ["-e", "process.exit(0)"] }, {}),
  /omen_native_mcp_required/,
  "OMEN execution must fail fast instead of silently falling back to SSH",
);

const t0 = performance.now();
const result = await start.handler({ executable: process.execPath, args: ["-e", "setTimeout(() => {}, 2000)"] }, {});
const elapsed = performance.now() - t0;
assert.ok(elapsed < 1800, `default start wait must stay short, got ${elapsed.toFixed(0)}ms`);
assert.equal(result.structuredContent?.process_state, "RUNNING", "long work should return a process id instead of blocking until completion");
console.log(`PASS omen_routing_safety fail_closed=true initial_wait_ms=${elapsed.toFixed(0)}`);
