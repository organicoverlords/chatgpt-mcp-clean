import assert from "node:assert/strict";
import { resolve } from "node:path";

process.env.MCP_TOOL_PROFILE = "process";
process.env.MCP_DEFAULT_EXECUTION_TARGET = "omen";
process.env.MCP_PROCESS_RECEIPT_DIR = resolve(".state/omen-routing-safety-receipts");
process.env.MCP_OMEN_EXEC_PATH = resolve(".state/legacy-omen-adapter-should-not-run.py");
delete process.env.MCP_OMEN_MCP_URL;
delete process.env.MCP_ALLOW_OMEN_SSH_FALLBACK;

const { createServer } = await import("../dist/server.js");
const server = createServer("omen-routing-safety");
const start = server._registeredTools.start_process;
assert.ok(start, "start_process missing");

await assert.rejects(
  () => start.handler({ executable: process.execPath, args: ["-e", "process.exit(0)"] }, {}),
  /omen_native_mcp_required/,
  "OMEN execution must fail fast instead of silently falling back to SSH",
);

console.log("PASS omen_routing_safety binding_owned=true fail_closed=true");
