import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { processLibraryUploadContent, processLibraryUploadFromOutput, processLibraryUploadMetadata, processLibraryUploadResourceContents, processLibraryUploadWidgetHtml, registerProcessLibraryUploadWidget } from "../dist/lib/process-library-upload.js";

const dir = await mkdtemp(join(tmpdir(), "mcp-process-upload-"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const imagePath = join(dir, "proof.png");
await writeFile(imagePath, png);
const upload = await processLibraryUploadFromOutput({ stdout: `ok\nCHATGPT_LIBRARY_UPLOAD=${imagePath}\n` });
assert(upload);
assert.equal(Buffer.from(upload.data_base64, "base64").compare(png), 0, "typed image payload must preserve exact original bytes");
const content = processLibraryUploadContent(upload);
assert.equal(content?.type, "resource_link");
assert.equal(content?.mimeType, "image/png");
assert.equal(content?.name, "proof.png");
assert.equal(content?.size, png.length);
assert.match(content?.uri ?? "", /^mcp-upload:\/\/process\/[0-9a-f-]{36}$/);
assert.deepEqual(content.annotations.audience, ["assistant", "user"]);
const resource = processLibraryUploadResourceContents(content.uri);
assert.equal(resource.mimeType, "image/png");
assert.equal(Buffer.from(resource.blob, "base64").compare(png), 0, "resources/read backing must preserve exact original bytes");
const server = new McpServer({ name: "process-upload-resource-test", version: "1" });
registerProcessLibraryUploadWidget(server);
const client = new Client({ name: "process-upload-resource-client", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  const templates = await client.listResourceTemplates();
  assert.ok(templates.resourceTemplates.some((item) => item.uriTemplate === "mcp-upload://process/{resource_id}"));
  const read = await client.readResource({ uri: content.uri });
  assert.equal(read.contents[0].mimeType, "image/png");
  assert.equal(Buffer.from(read.contents[0].blob, "base64").compare(png), 0, "MCP resources/read must preserve exact original bytes");
} finally {
  await client.close();
  await server.close();
}
const meta = processLibraryUploadMetadata(upload);
assert.equal(meta.file_name, "proof.png");
assert.equal(meta.bytes, png.length);
assert.equal(Object.hasOwn(meta, "data_base64"), false, "image bytes must not be duplicated into _meta");

const jsonPath = join(dir, "proof.json");
const json = Buffer.from("{\"ok\":true}", "utf8");
await writeFile(jsonPath, json);
const nonImage = await processLibraryUploadFromOutput({ stdout: `CHATGPT_LIBRARY_UPLOAD=${jsonPath}` });
assert(nonImage);
assert.equal(processLibraryUploadContent(nonImage), null);
assert.equal(processLibraryUploadMetadata(nonImage).data_base64, json.toString("base64"), "non-image Library uploads retain metadata bytes");

const widget = processLibraryUploadWidgetHtml();
assert.match(widget, /URL\.createObjectURL\(blob\)/);
assert.match(widget, /uploadFile\(file,\{library:true\}\)/);
console.log("process library upload resource-link tests passed");
