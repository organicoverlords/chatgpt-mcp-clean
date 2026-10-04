
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mcp-bootstrap-lifecycle-alias-"));
const fake = join(root, "fake-bootstrap.mjs");
writeFileSync(fake, [
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", chunk => input += chunk);',
  'process.stdin.on("end", () => {',
  '  process.stdout.write("ARGS:" + process.argv.slice(2).join(",") + "\\nBEGIN:" + input + "\\n" + "x".repeat(45000) + "\\nEND:" + input);',
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

async function runTurn(text, hasAttachments = false, messageId = undefined) {
  const pieces = [];
  let page = (await handler({ process_id: "bootstrap", stdin: text, has_attachments: hasAttachments, message_id: messageId, max_chars: 10000, wait_ms: 30000 }, {})).structuredContent;
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
  assert.match(first, /^ARGS:\nBEGIN:first exact user message\n/);
  assert.match(first, /END:first exact user message$/);
  assert.equal(first,"ARGS:\nBEGIN:first exact user message\n"+"x".repeat(45000)+"\nEND:first exact user message");
  const second = await runTurn("second exact user message", true, "turn-same-message");
  assert.match(second, /^ARGS:--message-id,turn-same-message,--has-attachments\nBEGIN:second exact user message\n/);
  assert.match(second, /END:second exact user message$/);

  const schema = server._registeredTools.read_output.inputSchema;
  assert.equal((await schema.safeParseAsync({ process_id: "bootstrap", stdin: "ok" })).success, true);
  assert.equal((await schema.safeParseAsync({ process_id: "bootstrap", stdin: "", has_attachments: true, message_id: "turn-same-message" })).success, true);
  assert.equal((await schema.safeParseAsync({ process_id: "not-bootstrap", stdin: "no" })).success, false);
  assert.equal((await schema.safeParseAsync({ process_id: "not-bootstrap", has_attachments: true })).success, false);
  assert.equal((await schema.safeParseAsync({ process_id: "not-bootstrap", message_id: "turn-no" })).success, false);
  if (process.env.MCP_LOCAL_ENGINE_URL) assert.equal(existsSync(join(root,"receipts")),false,"Rust lane must not initialize legacy Node process manager");
  console.log("PASS bootstrap lifecycle alias uses one public process id across paged turns");
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  assert.ok(root.startsWith(join(tmpdir(), "mcp-bootstrap-lifecycle-alias-")));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(failed ? 1 : 0);
