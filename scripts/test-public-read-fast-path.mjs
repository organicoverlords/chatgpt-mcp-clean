import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mcp-public-read-fast-"));
process.env.MCP_TOOL_PROFILE = "process";
process.env.MCP_PROCESS_RECEIPT_DIR = root;
const { createServer } = await import("../dist/server.js");
const server = createServer("read-fast-path-test");
let processId;
let failed = false;

try {
  const started = await server._registeredTools.start_process.handler({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('X'.repeat(10000)); setTimeout(() => {}, 10000)"],
    wait_ms: 0,
  }, {});
  processId = started.structuredContent.process_id;
  const first = (await server._registeredTools.read_output.handler({
    process_id: processId, max_chars: 200, wait_ms: 2_000,
  }, {})).structuredContent;
  assert.equal(first.output_page?.more, true, JSON.stringify(first));

  const at = Date.now();
  const second = (await server._registeredTools.read_output.handler({
    process_id: processId, max_chars: 200,
  }, {})).structuredContent;
  const elapsed = Date.now() - at;
  assert.equal(second.output_page?.stdout_start, 200, JSON.stringify(second));
  assert.equal(second.stdout.length, 200);
  assert.ok(elapsed < 500, `public read_output waited despite buffered output (${elapsed}ms)`);
  console.log(`PASS public_read_fast_path buffered_page_ms=${elapsed}`);
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  if (processId) await server._registeredTools.kill_process.handler({ process_id: processId }, {}).catch(() => { failed = true; });
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(failed ? 1 : 0);
