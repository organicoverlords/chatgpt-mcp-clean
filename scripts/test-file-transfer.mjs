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

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, raw] of entries) {
    const data = Buffer.from(raw);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
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

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7WQAAAAASUVORK5CYII=", "base64");
const pngPath = join(dir, "original.png");
await writeFile(pngPath, png);


const zipPngA = png;
const zipPngB = Buffer.concat([png, Buffer.from([0])]);
const zipManifest = Buffer.from(JSON.stringify({
  schema: "lowvram.visual-review-transfer.v1",
  label: "two-images",
  identity: { source: "test" },
  files: [
    { role: "asset_a", source_name: "asset-a.png", archive_path: "media/001_asset-a.png", bytes: zipPngA.length, sha256: sha256(zipPngA) },
    { role: "asset_b", source_name: "asset-b.png", archive_path: "media/002_asset-b.png", bytes: zipPngB.length, sha256: sha256(zipPngB) },
  ],
}) + "\n", "utf8");
const reviewZip = storedZip([
  ["manifest.json", zipManifest],
  ["media/001_asset-a.png", zipPngA],
  ["media/002_asset-b.png", zipPngB],
]);
const reviewZipPath = join(dir, "visual-review_two-images.zip");
await writeFile(reviewZipPath, reviewZip);

const p3ZipManifest = Buffer.from(JSON.stringify({
  schema: "p3.visual-review-transfer.v1",
  run_id: "test-run",
  mode: "Video",
  files: [
    { role: "primary", source_name: "proof.mp4", archive_path: "media/001_proof.mp4", bytes: 4, sha256: sha256(Buffer.from("vid0")), mime: "video/mp4" },
    { role: "contact_sheet", source_name: "contact-sheet.png", archive_path: "media/002_contact-sheet.png", bytes: zipPngA.length, sha256: sha256(zipPngA), mime: "image/png" },
    { role: "keyframe_0", source_name: "keyframe.png", archive_path: "media/003_keyframe.png", bytes: zipPngB.length, sha256: sha256(zipPngB), mime: "image/png" },
  ],
}) + "\n", "utf8");
const p3ReviewZip = storedZip([
  ["manifest.json", p3ZipManifest],
  ["media/001_proof.mp4", Buffer.from("vid0")],
  ["media/002_contact-sheet.png", zipPngA],
  ["media/003_keyframe.png", zipPngB],
]);
const p3ReviewZipPath = join(dir, "p3-visual-review_test.zip");
await writeFile(p3ReviewZipPath, p3ReviewZip);

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

  const imageUpload = await client.callTool({ name: "upload_local_file", arguments: { path: pngPath } });
  const imageLink = imageUpload.content.find((entry) => entry.type === "resource_link");
  assert.ok(imageLink, "image upload must return a same-turn resource_link for native vision");
  assert.equal(imageLink.mimeType, "image/png");
  assert.equal(imageLink.size, png.length, "image resource_link must describe the exact original byte count");
  const originalResource = await client.readResource({ uri: imageLink.uri });
  const originalBlob = originalResource.contents[0]?.blob;
  assert.ok(originalBlob, "image resource must expose original bytes");
  assert.equal(Buffer.from(originalBlob, "base64").compare(png), 0, "model vision resource must be byte-for-byte the original image, not a thumbnail");

  const reviewZipUpload = await client.callTool({ name: "upload_local_file", arguments: { path: reviewZipPath } });
  const reviewZipLinks = reviewZipUpload.content.filter((entry) => entry.type === "resource_link");
  assert.equal(reviewZipLinks.length, 2, "one visual-review ZIP must expose every manifest-declared image in the same tool result");
  assert.deepEqual(reviewZipLinks.map((entry) => entry.name), ["asset-a.png", "asset-b.png"]);
  const reviewZipExpected = [zipPngA, zipPngB];
  for (let index = 0; index < reviewZipLinks.length; index += 1) {
    const memberResource = await client.readResource({ uri: reviewZipLinks[index].uri });
    const memberBlob = memberResource.contents[0]?.blob;
    assert.ok(memberBlob, "visual-review ZIP member must resolve as native image resource bytes");
    assert.equal(Buffer.from(memberBlob, "base64").compare(reviewZipExpected[index]), 0, "visual-review ZIP member must remain byte-for-byte exact");
  }

  const p3ZipUpload = await client.callTool({ name: "upload_local_file", arguments: { path: p3ReviewZipPath } });
  const p3ZipLinks = p3ZipUpload.content.filter((entry) => entry.type === "resource_link");
  assert.deepEqual(p3ZipLinks.map((entry) => entry.name), ["contact-sheet.png", "keyframe.png"], "P3 review ZIP must expose image review media without mislabeling the video as image evidence");
  for (let index = 0; index < p3ZipLinks.length; index += 1) {
    const memberResource = await client.readResource({ uri: p3ZipLinks[index].uri });
    const memberBlob = memberResource.contents[0]?.blob;
    assert.ok(memberBlob, "P3 review ZIP image must resolve as native image resource bytes");
    assert.equal(Buffer.from(memberBlob, "base64").compare(reviewZipExpected[index]), 0, "P3 review ZIP image must remain byte-for-byte exact");
  }

  const textUpload = await client.callTool({ name: "upload_local_file", arguments: { path: textPath } });
  assert.equal(textUpload.content.some((entry) => entry.type === "resource_link"), false, "non-image uploads must not add image resource content");

  const resource = await client.readResource({ uri: FILE_TRANSFER_WIDGET_URI });
  const meta = resource.contents[0]?._meta;
  assert.deepEqual(meta?.ui?.csp?.connectDomains, ["https://mcp.example.test"]);
  assert.deepEqual(meta?.["openai/widgetCSP"]?.connect_domains, ["https://mcp.example.test"]);
} finally {
  await client.close();
  await server.close();
}

const widget = fileTransferWidgetHtml();
assert.match(widget, /<img id="image" class="image"/);
assert.match(widget, /imageEl\.src=URL\.createObjectURL\(blob\)/, "widget must render an inline preview from the exact fetched image bytes");
assert.match(widget, /const file=new File\(\[blob\],p\.file_name/, "Library upload must reuse the same exact bytes shown in the preview");
assert.match(widget, /uploadFile\(file,\{library:true\}\)/);
assert.match(widget, /crypto\.subtle\.digest\('SHA-256',data\)/);
assert.doesNotMatch(widget, /getFileDownloadUrl|callTool\(/, "download path should not need a widget round trip");

console.log("PASS lossless file transfer: exact images and visual-review ZIP resources, inline preview, raw bytes, zstd, native file params");
