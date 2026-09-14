import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const local = await mkdtemp(join(tmpdir(), "mcp-visual-proof-read-"));
process.env.LOCALAPPDATA = local;
process.env.MCP_PROCESS_RECEIPT_DIR = join(local, "receipts");
process.env.MCP_PUBLIC_ORIGIN = "https://mcp.example.test/";
const spool = join(local, "ChatGPTMcpFrozen", "handoff-spool");
const queue = join(spool, "queue");
await mkdir(queue, { recursive: true });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7WQAAAAASUVORK5CYII=", "base64");
const sha256 = createHash("sha256").update(png).digest("hex");
for (let i = 1; i <= 2; i += 1) {
  const filePath = join(spool, `proof-${i}.png`);
  await writeFile(filePath, png);
  await writeFile(join(queue, `${String(i).padStart(4, "0")}.json`), JSON.stringify({ path: filePath, bytes: png.length, sha256 }));
}
const { createServer } = await import("../dist/server.js");
const server = createServer("visual-proof-read-alias-test");
const client = new Client({ name: "visual-proof-read-alias-client", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  const listed = await client.listTools();
  assert.equal(listed.tools.some((tool) => tool.name === "visual_proof"), false, "must not add a new tool/action");
  const read = listed.tools.find((tool) => tool.name === "read_output");
  assert.ok(read);
  assert.equal(read._meta?.["openai/outputTemplate"], undefined);
  const result = await client.callTool({ name: "read_output", arguments: { process_id: "visual-proof" } });
  assert.equal(result.isError, undefined);
  const links = result.content.filter((entry) => entry.type === "resource_link");
  assert.equal(links.length, 2, "one read_output call must return both queued images");
  for (const link of links) {
    assert.equal(link.mimeType, "image/png");
    const resource = await client.readResource({ uri: link.uri });
    assert.equal(Buffer.from(resource.contents[0].blob, "base64").compare(png), 0);
  }
  assert.equal((await readdir(queue)).length, 0, "delivered manifests must be acknowledged only after handoff succeeds");
  const replay = await client.callTool({ name: "read_output", arguments: { process_id: "visual-proof" } });
  assert.equal(replay.content.filter((entry) => entry.type === "resource_link").length, 0, "delivered images must not replay");
  assert.equal(replay.structuredContent?.no_change, true);
} finally {
  await client.close();
  await server.close();
}
console.log("PASS visual_proof_read_alias cached_read_output=true start_process_calls=0 queued_images=2 resource_links=2 exact_bytes=true replay=false");
