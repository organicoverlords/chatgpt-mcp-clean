import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { awaitRequestOrDisconnect } from "../dist/request-lifecycle.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let activeRequests = 0;
let handlerStarted = false;
let handlerAborted = false;

const app = express();
app.use(express.json());
app.post("/mcp", async (req, res) => {
  activeRequests += 1;
  const server = new McpServer({ name: "request-abort-lifecycle-test", version: "1.0.0" });
  server.registerTool("slow", { inputSchema: z.object({}) }, async (_input, extra) => {
    handlerStarted = true;
    await new Promise((resolve) => {
      if (extra.signal.aborted) {
        handlerAborted = true;
        resolve();
        return;
      }
      extra.signal.addEventListener("abort", () => {
        handlerAborted = true;
        resolve();
      }, { once: true });
    });
    return { content: [{ type: "text", text: "done" }] };
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  res.once("finish", () => void cleanup());
  res.once("close", () => void cleanup());

  try {
    await server.connect(transport);
    await awaitRequestOrDisconnect(req, res, () => transport.handleRequest(req, res, req.body));
  } finally {
    activeRequests -= 1;
  }
});

const httpServer = createHttpServer(app);
await new Promise((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(0, "127.0.0.1", resolve);
});
const address = httpServer.address();
assert.ok(address && typeof address === "object");
const origin = `http://127.0.0.1:${address.port}`;

try {
  const controller = new AbortController();
  const request = fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow", arguments: {} } }),
    signal: controller.signal,
  }).catch(() => undefined);

  for (let attempt = 0; attempt < 100 && !handlerStarted; attempt += 1) await sleep(10);
  assert.equal(handlerStarted, true, "slow tool handler never started");
  assert.equal(activeRequests, 1, "request must be active before downstream abort");
  controller.abort();
  await request;
  for (let attempt = 0; attempt < 100 && activeRequests !== 0; attempt += 1) await sleep(10);
  assert.equal(handlerAborted, true, "downstream abort must propagate into the MCP tool handler");
  assert.equal(activeRequests, 0, "downstream abort must release the outer HTTP request lifecycle");
  console.log("PASS request_abort_lifecycle handler_aborted=true active_requests=0");
} finally {
  httpServer.closeAllConnections?.();
  await new Promise((resolve) => httpServer.close(resolve));
}
