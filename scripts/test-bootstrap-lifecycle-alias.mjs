
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mcp-bootstrap-lifecycle-alias-"));
const fake = join(root, "fake-bootstrap.mjs");
writeFileSync(fake, [
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", chunk => input += chunk);',
  'process.stdin.on("end", () => {',
  '  process.stdout.write("BEGIN:" + input + "\\n" + "x".repeat(45000) + "\\nEND:" + input);',
  '});',
].join("\n"));

process.env.MCP_TOOL_PROFILE = "process";
process.env.MCP_PROCESS_RECEIPT_DIR = join(root, "receipts");
process.env.MCP_BOOTSTRAP_ALIAS_EXECUTABLE = process.execPath;
process.env.MCP_BOOTSTRAP_ALIAS_ARGS_JSON = JSON.stringify([fake]);
process.env.MCP_BOOTSTRAP_ALIAS_CWD = root;

const { createServer } = await import("../dist/server.js");
const server = createServer("bootstrap-lifecycle-alias-test");
const handler = server._registeredTools.read_output.handler;

async function runTurn(text) {
  const pieces = [];
  let page = (await handler({ process_id: "bootstrap", stdin: text, max_chars: 10000, wait_ms: 30000 }, {})).structuredContent;
  while (true) {
    assert.equal(page.process_id, "bootstrap");
    assert.equal(page.bootstrap_alias, true);
    assert.equal("command" in page, false);
    assert.equal("cwd" in page, false);
    pieces.push(page.stdout ?? "");
    if (page.next_action === "STOP_READING") break;
    page = (await handler({ process_id: "bootstrap", max_chars: 10000, wait_ms: 30000 }, {})).structuredContent;
  }
  return pieces.join("");
}

let failed = false;
try {
  const first = await runTurn("first exact user message");
  assert.match(first, /^BEGIN:first exact user message\n/);
  assert.match(first, /END:first exact user message$/);
  const second = await runTurn("second exact user message");
  assert.match(second, /^BEGIN:second exact user message\n/);
  assert.match(second, /END:second exact user message$/);

  const schema = server._registeredTools.read_output.inputSchema;
  assert.equal((await schema.safeParseAsync({ process_id: "bootstrap", stdin: "ok" })).success, true);
  assert.equal((await schema.safeParseAsync({ process_id: "not-bootstrap", stdin: "no" })).success, false);
  console.log("PASS bootstrap lifecycle alias uses one public process id across paged turns");
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(failed ? 1 : 0);
