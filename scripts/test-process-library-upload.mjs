import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { processLibraryUploadContent, processLibraryUploadFromOutput, processLibraryUploadMetadata, processLibraryUploadResourceContents, processLibraryUploadWidgetHtml, registerProcessLibraryUploadWidget, PROCESS_LIBRARY_UPLOAD_WIDGET_URI } from "../dist/lib/process-library-upload.js";

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
assert.equal(meta.data_base64, png.toString("base64"), "image bytes must remain available in hidden widget metadata");
assert.equal(meta.sha256, upload.sha256);

const jsonPath = join(dir, "proof.json");
const json = Buffer.from("{\"ok\":true}", "utf8");
await writeFile(jsonPath, json);
const nonImage = await processLibraryUploadFromOutput({ stdout: `CHATGPT_LIBRARY_UPLOAD=${jsonPath}` });
assert(nonImage);
assert.equal(processLibraryUploadContent(nonImage), null);
assert.equal(processLibraryUploadMetadata(nonImage).data_base64, json.toString("base64"), "non-image Library uploads retain metadata bytes");

assert.equal(PROCESS_LIBRARY_UPLOAD_WIDGET_URI, "ui://process/library-upload-v2.html", "breaking widget changes require a fresh cache-key URI");
const widget = processLibraryUploadWidgetHtml();
assert.match(widget, /URL\.createObjectURL\(blob\)/);
assert.match(widget, /uploadFile\(file,\{library:true\}\)/);
assert.match(widget, /imageIds:fileId&&p\.mime_type\.startsWith\('image\/'\)\?\[fileId\]:\[\]/);

const uploadedBytes = [];
const uploadOptions = [];
const widgetStates = [];
const parent = { postMessage() {} };
const elements = {
  status: { textContent: "", classList: { add() {} } },
  image: { src: "", classList: { add() {} } },
};
const window = {
  parent,
  openai: {
    toolResponseMetadata: { mcp_tool_result: { _meta: { chatgpt_library_upload: meta } } },
    notifyIntrinsicHeight() {},
    async uploadFile(file, options) {
      uploadOptions.push(options);
      uploadedBytes.push(Buffer.from(await file.arrayBuffer()));
      return { fileId: "file_widget_exact" };
    },
    setWidgetState(state) { widgetStates.push(state); },
  },
  addEventListener() {},
};
runInNewContext(widget.match(/<script>([\s\S]*?)<\/script>/)[1], {
  window,
  document: { getElementById: (id) => elements[id] },
  atob, Uint8Array, Blob, File,
  URL: { createObjectURL: () => "blob:test" },
});
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
assert.equal(uploadedBytes.length, 1, "widget must upload the metadata-backed image exactly once");
assert.equal(uploadOptions[0]?.library, true, "widget must request Library persistence");
assert.equal(uploadedBytes[0].compare(png), 0, "widget uploadFile payload must preserve exact original bytes");
assert.equal(widgetStates.at(-1)?.imageIds?.length, 1, "widget must publish exactly one uploaded image id");
assert.equal(widgetStates.at(-1)?.imageIds?.[0], "file_widget_exact", "widget must publish uploaded image id for follow-up model context");

console.log("process library upload widget-v2 metadata tests passed");
