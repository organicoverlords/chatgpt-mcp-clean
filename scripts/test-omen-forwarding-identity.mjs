import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mcp-omen-forwarding-"));
const seen = [];
const initialized = [];
const mock = createHttpServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) { response.writeHead(405).end(); return; }
  const call = JSON.parse(body);
  const session = String(request.headers["x-openai-session"] ?? "");
  if (call.method === "notifications/initialized") {
    response.writeHead(202).end();
    return;
  }
  let result;
  if (call.method === "initialize") {
    initialized.push(session);
    result = { protocolVersion: call.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mock-omen", version: "1" } };
  } else if (call.method === "tools/call") {
    seen.push({ session, name: call.params.name });
    if (call.params.arguments?.executable === "deny") {
      result = { isError: true, content: [{ type: "text", text: "start_process_concurrency_limited: live_process_count=4; max_live_processes=4; active_process_ids=; rejection_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] };
    } else {
      result = { content: [], structuredContent: {
        process_id: "11111111-1111-4111-8111-111111111111",
        caller_id: `native-${session}`,
        mcp_status: "OK", process_state: "RUNNING", elapsed_ms: 0,
        next_action: "READ_SAME_PROCESS_ID", running: true,
      } };
    }
  } else {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const address = mock.address();
process.env.MCP_TOOL_PROFILE = "process";
process.env.MCP_PROCESS_RECEIPT_DIR = root;
process.env.MCP_OMEN_MCP_URL = `http://127.0.0.1:${address.port}/mcp`;
const { createServer, closeRemoteOmenClients } = await import("../dist/server.js");
let failed = false;
try {
  const first = createServer("caller-one");
  const second = createServer("caller-two");
  async function start(server, executable) {
    return await server._registeredTools.start_process.handler({ executable, args: [], execution_target: "omen", wait_ms: 0 }, {});
  }
  const a = (await start(first, "ok")).structuredContent;
  const b = (await start(second, "ok")).structuredContent;
  assert.equal(a.caller_id, "caller-one");
  assert.equal(b.caller_id, "caller-two");
  assert.notEqual(a.execution_caller_id, b.execution_caller_id);
  assert.deepEqual(seen.map((entry) => entry.session), ["proxy:caller-one", "proxy:caller-two"]);
  await assert.rejects(() => start(first, "deny"), /omen_start_process_concurrency_limited.*rejection_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
  await start(first, "ok-again");
  assert.deepEqual(initialized, ["proxy:caller-one", "proxy:caller-two"], "a tool-level rejection must not reconnect the caller");
  console.log("PASS omen_forwarding_identity distinct_callers=true rejection_reason_preserved=true");
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  await closeRemoteOmenClients();
  await new Promise((resolve) => mock.close(resolve));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(failed ? 1 : 0);
