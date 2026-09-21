import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform === "win32") {
  console.log("SKIP native OMEN Linux contract on Windows");
  process.exit(0);
}

const state = mkdtempSync(join(tmpdir(), "native-omen-mcp-"));
process.env.MCP_TOOL_PROFILE = "process";
process.env.MCP_DEFAULT_EXECUTION_TARGET = "omen";
process.env.MCP_NATIVE_OMEN_HOST = "1";
process.env.MCP_PROCESS_RECEIPT_DIR = join(state, "receipts");
const { createServer } = await import("../dist/server.js");
const server = createServer("native-omen-linux-test", { backend_generation: "native-omen-test", source_commit: "0123456789abcdef0123456789abcdef01234567" });

async function call(name, args) {
  const tool = server._registeredTools[name];
  assert.ok(tool, `${name} missing`);
  const result = await tool.handler(args, {});
  assert.ok(result.structuredContent, `${name} missing structuredContent`);
  return result.structuredContent;
}

try {
  const hostname = await call("start_process", { executable: "hostname", args: [], wait_ms: 10_000 });
  assert.equal(hostname.process_state, "COMPLETED", JSON.stringify(hostname));
  assert.equal(hostname.exit_code, 0, JSON.stringify(hostname));
  assert.equal(hostname.execution_target, "omen");
  assert.equal(hostname.execution_transport, "native-mcp");
  assert.doesNotMatch(String(hostname.command || ""), /omen_exec|ssh/i);
  assert.ok(String(hostname.stdout || "").trim().length > 0);

  const sleeper = await call("start_process", { executable: "bash", args: ["-lc", "sleep 30"], wait_ms: 0 });
  assert.equal(sleeper.execution_transport, "native-mcp");
  const killed = await call("kill_process", { process_id: sleeper.process_id });
  assert.equal(killed.killed, true, JSON.stringify(killed));
  console.log(`PASS native_omen_linux hostname=${String(hostname.stdout).trim()} transport=${hostname.execution_transport} kill=true`);
} finally {
  rmSync(state, { recursive: true, force: true });
}
