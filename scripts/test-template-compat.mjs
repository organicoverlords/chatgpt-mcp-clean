import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MCP_PUBLIC_ORIGIN = "https://mcp.example.test/";
process.env.MCP_PROCESS_RECEIPT_DIR = join(await mkdtemp(join(tmpdir(), "mcp-template-compat-")), "receipts");

const { FILE_TRANSFER_WIDGET_URI } = await import("../dist/lib/file-transfer.js");
const { LEGACY_PROCESS_LIBRARY_UPLOAD_WIDGET_URI } = await import("../dist/lib/template-compat.js");
const { createServer } = await import("../dist/server.js");

const server = createServer("caller_template_compat_test");
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "template-compat-test", version: "1.0.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

try {
  const listed = await client.listTools();
  const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.start_process?._meta?.["openai/outputTemplate"], undefined, "start_process must not mount an app template on this generation");
  assert.equal(byName.read_output?._meta?.["openai/outputTemplate"], undefined, "read_output must not mount an app template on this generation");
  assert.equal(byName.upload_local_file?._meta?.["openai/outputTemplate"], FILE_TRANSFER_WIDGET_URI, "working upload_local_file template contract must remain unchanged");

  const current = await client.readResource({ uri: FILE_TRANSFER_WIDGET_URI });
  assert.equal(current.contents[0]?.mimeType, "text/html;profile=mcp-app", "current file-transfer template must remain readable");

  const legacy = await client.readResource({ uri: LEGACY_PROCESS_LIBRARY_UPLOAD_WIDGET_URI });
  assert.equal(legacy.contents[0]?.mimeType, "text/html;profile=mcp-app", "legacy cached process template URI must resolve");
  assert.match(String(legacy.contents[0]?.text || ""), /mcp-template-compat/, "legacy URI must return a valid compatibility app");
} finally {
  await client.close();
  await server.close();
}

console.log("template compatibility regression passed");
