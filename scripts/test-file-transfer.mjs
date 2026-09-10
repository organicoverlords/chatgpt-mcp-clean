import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { zstdDecompressSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MCP_PUBLIC_ORIGIN = "https://mcp.example.test/";
const dir = await mkdtemp(join(tmpdir(), "mcp-file-transfer-"));
process.env.MCP_PROCESS_RECEIPT_DIR = join(dir, "receipts");

const {
  FILE_TRANSFER_WIDGET_URI,
  assertPublicHttpsUrl,
  downloadChatgptFile,
  fileTransferWidgetHtml,
  prepareLocalFileTransfer,
  serveLocalFileTransfer,
} = await import("../dist/lib/file-transfer.js");
const { createServer } = await import("../dist/server.js");

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function serve(item, acceptEncoding) {
  const chunks = [];
  const headers = new Map();
  const res = new PassThrough();
  res.statusCode = 200;
  res.setHeader = (name, value) => { headers.set(String(name).toLowerCase(), String(value)); return res; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (body) => { res.end(body); return res; };
  res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const req = {
    query: { token: item.token },
    header(name) { return String(name).toLowerCase() === "accept-encoding" ? acceptEncoding : undefined; },
  };
  await serveLocalFileTransfer(req, res);
  return { body: Buffer.concat(chunks), headers, statusCode: res.statusCode };
}

const text = Buffer.alloc(512 * 1024, 65);
const textPath = join(dir, "compressible.txt");
await writeFile(textPath, text);
const textItem = await prepareLocalFileTransfer(textPath);
assert.equal(textItem.bytes, text.length);
assert.equal(textItem.sha256, sha256(text));
const zstd = await serve(textItem, "gzip, zstd");
assert.equal(zstd.statusCode, 200);
assert.equal(zstd.headers.get("content-encoding"), "zstd");
assert.equal(zstd.headers.get("x-file-transfer-encoding"), "zstd-1");
assert.ok(zstd.body.length < text.length / 10, "zstd should materially shrink compressible transfer bytes");
assert.equal(zstdDecompressSync(zstd.body).compare(text), 0, "zstd transfer must decode to exact original bytes");

const media = randomBytes(256 * 1024);
const mediaPath = join(dir, "proof.mp4");
await writeFile(mediaPath, media);
const mediaItem = await prepareLocalFileTransfer(mediaPath);
const mediaTransfer = await serve(mediaItem, "zstd");
assert.equal(mediaTransfer.headers.get("content-encoding"), undefined, "already-compressed media must not be zstd wrapped");
assert.equal(mediaTransfer.headers.get("x-file-transfer-encoding"), "identity");
assert.equal(mediaTransfer.body.compare(media), 0, "media transfer must preserve exact bytes");
const replay = await serve(mediaItem, "identity");
assert.equal(replay.statusCode, 404, "completed upload capability URL must be single-use");

const incoming = randomBytes(1024 * 1024 + 17);
const destination = join(dir, "received", "generated.glb");
let fetchCalls = 0;
const result = await downloadChatgptFile(
  { download_url: "https://files.example.test/generated.glb", file_id: "file_generated", mime_type: "model/gltf-binary", file_name: "generated.glb" },
  destination,
  false,
  {
    validateUrl: async (raw) => new URL(raw),
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(incoming, { status: 200, headers: { "content-length": String(incoming.length) } });
    },
  },
);
assert.equal(fetchCalls, 1);
assert.equal(result.bytes, incoming.length);
assert.equal(result.sha256, sha256(incoming));
assert.equal((await readFile(destination)).compare(incoming), 0, "ChatGPT -> local transfer must preserve exact bytes");
await assert.rejects(() => assertPublicHttpsUrl("https://127.0.0.1/private"), /private address/);

const server = createServer("file-transfer-contract-test");
const client = new Client({ name: "file-transfer-contract-client", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["download_chatgpt_file", "kill_process", "read_output", "start_process", "upload_local_file"]);
const listedByName = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
assert.ok(listedByName.upload_local_file.outputSchema, "upload tool must declare outputSchema for structuredContent");
assert.ok(listedByName.download_chatgpt_file.outputSchema, "download tool must declare outputSchema for structuredContent");
  const start = listed.tools.find((tool) => tool.name === "start_process");
  const read = listed.tools.find((tool) => tool.name === "read_output");
  const upload = listed.tools.find((tool) => tool.name === "upload_local_file");
  const download = listed.tools.find((tool) => tool.name === "download_chatgpt_file");
  assert.equal(start?._meta?.["openai/outputTemplate"], undefined, "start_process must not mount the file widget");
  assert.equal(read?._meta?.["openai/outputTemplate"], undefined, "read_output must not mount the file widget");
  assert.equal(upload?._meta?.["openai/outputTemplate"], FILE_TRANSFER_WIDGET_URI, "only upload_local_file needs the upload widget");
  assert.equal(download?._meta?.["openai/outputTemplate"], undefined, "download_chatgpt_file should use native file params, not a widget");
  assert.deepEqual(download?._meta?.["openai/fileParams"], ["file"]);
  const fileSchema = download?.inputSchema?.properties?.file;
  assert.deepEqual(fileSchema?.required, ["download_url", "file_id"]);
  assert.deepEqual(Object.keys(fileSchema?.properties || {}).sort(), ["download_url", "file_id", "file_name", "mime_type"]);

  const resource = await client.readResource({ uri: FILE_TRANSFER_WIDGET_URI });
  const meta = resource.contents[0]?._meta;
  assert.deepEqual(meta?.ui?.csp?.connectDomains, ["https://mcp.example.test"]);
  assert.deepEqual(meta?.["openai/widgetCSP"]?.connect_domains, ["https://mcp.example.test"]);
} finally {
  await client.close();
  await server.close();
}

const widget = fileTransferWidgetHtml();
assert.match(widget, /uploadFile\(file,\{library:true\}\)/);
assert.match(widget, /crypto\.subtle\.digest\('SHA-256',data\)/);
assert.doesNotMatch(widget, /getFileDownloadUrl|callTool\(/, "download path should not need a widget round trip");

console.log("PASS lossless file transfer: raw bytes, zstd, native file params, isolated upload widget");
