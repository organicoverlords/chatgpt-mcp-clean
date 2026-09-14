import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const dir = await mkdtemp(join(tmpdir(), "mcp-process-native-handoff-"));
process.env.MCP_PROCESS_RECEIPT_DIR = join(dir, "receipts");
process.env.MCP_PUBLIC_ORIGIN = "https://mcp.example.test/";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7WQAAAAASUVORK5CYII=", "base64");
const pngPath = join(dir, "proof.png");
await writeFile(pngPath, png);
const sha256 = createHash("sha256").update(png).digest("hex");

const { createServer } = await import("../dist/server.js");
const server = createServer("process-native-handoff-test");
const client = new Client({ name: "process-native-handoff-client", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  const listed = await client.listTools();
  const start = listed.tools.find((tool) => tool.name === "start_process");
  const read = listed.tools.find((tool) => tool.name === "read_output");
  assert.ok(start && read);
  assert.equal(start._meta?.["openai/outputTemplate"], undefined, "marker handoff must not remount a start_process widget");
  assert.equal(read._meta?.["openai/outputTemplate"], undefined, "marker handoff must not remount a read_output widget");
  assert.equal(start._meta?.ui?.resourceUri, undefined, "marker handoff must not add app binding metadata");
  assert.equal(read._meta?.ui?.resourceUri, undefined, "marker handoff must not add app binding metadata");

  const code = `process.stdout.write(${JSON.stringify(`CHATGPT_LIBRARY_UPLOAD=${pngPath}\n`)})`;
  const result = await client.callTool({
    name: "start_process",
    arguments: { executable: process.execPath, args: ["-e", code], wait_ms: 10_000 },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result._meta, undefined, "process marker handoff must stay free of widget/upload metadata");
  assert.equal(result.structuredContent?.file_transfer, undefined, "process output schema must remain unchanged");
  const link = result.content.find((entry) => entry.type === "resource_link");
  assert.ok(link, "completed start_process marker must append a native resource_link in the same call result");
  assert.equal(link.mimeType, "image/png");
  assert.equal(link.size, png.length);
  const resource = await client.readResource({ uri: link.uri });
  const blob = resource.contents[0]?.blob;
  assert.ok(blob, "native marker resource must be readable");
  const bytes = Buffer.from(blob, "base64");
  assert.equal(bytes.compare(png), 0, "native marker resource must preserve exact original bytes");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);

  const slowCode = `setTimeout(()=>process.stdout.write(${JSON.stringify(`CHATGPT_LIBRARY_UPLOAD=${pngPath}\n`)}),150)`;
  const started = await client.callTool({
    name: "start_process",
    arguments: { executable: process.execPath, args: ["-e", slowCode], wait_ms: 0 },
  });
  const processId = started.structuredContent?.process_id;
  assert.ok(processId);
  let readResult;
  for (let i = 0; i < 20; i += 1) {
    readResult = await client.callTool({ name: "read_output", arguments: { process_id: processId, wait_ms: 250 } });
    if (readResult.content.some((entry) => entry.type === "resource_link")) break;
  }
  const readLink = readResult?.content.find((entry) => entry.type === "resource_link");
  assert.ok(readLink, "read_output must append the same native resource_link when the marker arrives asynchronously");
  const readResource = await client.readResource({ uri: readLink.uri });
  assert.equal(Buffer.from(readResource.contents[0].blob, "base64").compare(png), 0);
} finally {
  await client.close();
  await server.close();
}

console.log("PASS process_native_handoff cached_action=true widget=false schema_unchanged=true exact_resource=true start_same_turn=true read_async=true");
