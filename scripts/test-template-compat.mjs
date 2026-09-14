import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MCP_PUBLIC_ORIGIN = "https://mcp.example.test/";
process.env.MCP_PROCESS_RECEIPT_DIR = join(await mkdtemp(join(tmpdir(), "mcp-template-compat-")), "receipts");
process.env.MCP_TOOL_PROFILE = "process";

const { FILE_TRANSFER_WIDGET_URI } = await import("../dist/lib/file-transfer.js");
const { LEGACY_PROCESS_LIBRARY_UPLOAD_WIDGET_URIS, LEGACY_VISUAL_PROOF_WIDGET_URI } = await import("../dist/lib/template-compat.js");
const { createServer } = await import("../dist/server.js");

const server = createServer("caller_template_compat_test");
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "template-compat-test", version: "1.0.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

try {
  const listed = await client.listTools();
  const byName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
  for (const name of ["start_process", "read_output", "upload_local_file"]) {
    const meta = byName[name]?._meta;
    assert.equal(meta?.["openai/outputTemplate"], undefined, `${name} must not mount an app/widget template`);
    assert.equal(meta?.["ui/resourceUri"], undefined, `${name} must not advertise an app resource URI`);
    assert.equal(meta?.ui, undefined, `${name} must not advertise nested app UI metadata`);
  }
  const expectedUris = [FILE_TRANSFER_WIDGET_URI, ...LEGACY_PROCESS_LIBRARY_UPLOAD_WIDGET_URIS, LEGACY_VISUAL_PROOF_WIDGET_URI];
  for (const uri of expectedUris) {
    const resource = await client.readResource({ uri });
    assert.equal(resource.contents[0]?.uri, uri, `${uri} must resolve exactly`);
    assert.equal(resource.contents[0]?.mimeType, "text/html;profile=mcp-app", `${uri} must remain an MCP app template`);
    assert.ok(String(resource.contents[0]?.text || "").includes("<!doctype html>"), `${uri} must return HTML`);
  }
} finally {
  await client.close();
  await server.close();
}

console.log(`template compatibility regression passed uris=${[FILE_TRANSFER_WIDGET_URI, ...LEGACY_PROCESS_LIBRARY_UPLOAD_WIDGET_URIS, LEGACY_VISUAL_PROOF_WIDGET_URI].join(",")}`);
