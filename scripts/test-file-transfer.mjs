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


const tiny3dReceipt = Buffer.from(JSON.stringify({ schema: "tiny3d.library-preview.v1", asset_id: "a".repeat(64) }) + "\n", "utf8");
const tiny3dViews = Array.from({ length: 12 }, (_, index) => {
  const label = `view_${String(index).padStart(2, "0")}`;
  const data = Buffer.concat([png, Buffer.from([index])]);
  return { label, data, archive_path: `assets/${"a".repeat(64)}/views/${label}.png` };
});
const tiny3dZipManifest = Buffer.from(JSON.stringify({
  schema: "tiny3d.visual-review-transfer.v1",
  asset_count: 1,
  media_count: 12,
  assets: [{
    asset_id: "a".repeat(64),
    view_set: "twelve_standard_v1",
    receipt: { archive_path: `assets/${"a".repeat(64)}/receipts/library_preview.json`, bytes: tiny3dReceipt.length, sha256: sha256(tiny3dReceipt), schema: "tiny3d.library-preview.v1" },
    views: tiny3dViews.map(({ label, data, archive_path }) => ({ label, archive_path, bytes: data.length, sha256: sha256(data), mime: "image/png" })),
  }],
}) + "\n", "utf8");
const tiny3dReviewZip = storedZip([
  ["manifest.json", tiny3dZipManifest],
  [`assets/${"a".repeat(64)}/receipts/library_preview.json`, tiny3dReceipt],
  ...tiny3dViews.map(({ archive_path, data }) => [archive_path, data]),
]);
const tiny3dReviewZipPath = join(dir, "tiny3d-visual-review_test.zip");
await writeFile(tiny3dReviewZipPath, tiny3dReviewZip);

const genericZipPath = join(dir, "generic.zip");
const genericZip = storedZip([["note.txt", Buffer.from("not a review package")]]);
await writeFile(genericZipPath, genericZip);

const media = randomBytes(256 * 1024);
const mediaPath = join(dir, "proof.mp4");
await writeFile(mediaPath, media);
const mediaItem = await prepareLocalFileTransfer(mediaPath);
const mediaTransfer = await serve(mediaItem, "zstd");
assert.equal(mediaTransfer.headers.get("content-encoding"), undefined, "already-compressed media must not be zstd wrapped");
assert.equal(mediaTransfer.headers.get("x-file-transfer-encoding"), "identity");
assert.equal(mediaTransfer.body.compare(media), 0, "media transfer must preserve exact bytes");
const replay = await serve(mediaItem, "identity");
assert.equal(replay.statusCode, 200, "upload capability must survive a normal widget remount within its bounded TTL");
assert.equal(replay.headers.get("x-file-sha256"), mediaItem.sha256, "replayed upload must preserve the prepared hash");
assert.equal(replay.body.compare(media), 0, "replayed upload must preserve exact bytes");

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
assert.equal(FILE_TRANSFER_WIDGET_URI, "ui://process/file-transfer-v4.html", "widget URI must be cache-busted after restoring HTTPS Library materialization only on upload_local_file");
  const start = listed.tools.find((tool) => tool.name === "start_process");
  const read = listed.tools.find((tool) => tool.name === "read_output");
  const upload = listed.tools.find((tool) => tool.name === "upload_local_file");
  const download = listed.tools.find((tool) => tool.name === "download_chatgpt_file");
  assert.ok(start?.inputSchema?.properties?.command, "start_process must expose legacy command input");
  assert.ok(start?.inputSchema?.properties?.executable, "start_process must expose structured executable input");
  assert.ok(start?.inputSchema?.properties?.args, "start_process must expose structured argv input");
  assert.equal(start?._meta, undefined, "start_process must be completely widget/app-metadata free");
  assert.equal(read?._meta, undefined, "read_output must be completely widget/app-metadata free");
  assert.equal(upload?._meta?.ui?.resourceUri, FILE_TRANSFER_WIDGET_URI, "upload_local_file advertises the modern MCP Apps resource URI");
  assert.equal(upload?._meta?.["ui/resourceUri"], FILE_TRANSFER_WIDGET_URI, "upload_local_file mirrors the MCP Apps compatibility URI expected by host bindings");
  assert.equal(upload?._meta?.["openai/outputTemplate"], FILE_TRANSFER_WIDGET_URI, "upload_local_file alone mounts the HTTPS Library widget");
  assert.equal(download?._meta?.["openai/outputTemplate"], undefined, "download_chatgpt_file should use native file params, not a widget");
  assert.deepEqual(download?._meta?.["openai/fileParams"], ["file"]);
  const fileSchema = download?.inputSchema?.properties?.file;
  assert.deepEqual(fileSchema?.required, ["download_url", "file_id"]);
  assert.deepEqual(Object.keys(fileSchema?.properties || {}).sort(), ["download_url", "file_id", "file_name", "mime_type"]);

  assert.deepEqual(upload?.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, "local file export remains a closed-domain action");

  function exactFileReference(result, expectedName, expectedMime, expectedBytes) {
    const summary = result.structuredContent;
    assert.equal(summary?.delivery_mode, "tool_file_reference", "file handoff must be model-visible without UI");
    assert.equal(summary?.file_name, expectedName);
    assert.equal(summary?.mime_type, expectedMime);
    assert.equal(summary?.bytes, expectedBytes);
    const ref = result.content.find((entry) => entry.type === "resource_link" && entry.uri === summary?.resource_uri);
    assert.ok(ref, "file handoff must return the exact original as a first-class tool-result file reference");
    assert.equal(ref.name, expectedName);
    assert.equal(ref.mimeType, expectedMime);
    assert.equal(ref.size, expectedBytes);
    assert.match(ref.uri, /^mcp-upload:\/\/file-transfer\//);
    return ref;
  }

  const imageUpload = await client.callTool({ name: "upload_local_file", arguments: { path: pngPath } });
  assert.equal(imageUpload._meta?.file_transfer?.delivery_mode, "library_upload", "direct image keeps native result and restores HTTPS Library upload");
  assert.match(imageUpload._meta?.file_transfer?.transfer_url || "", /^https:\/\//);
  assert.equal(imageUpload._meta?.file_transfer?.sha256, imageUpload.structuredContent.sha256);
  const nativeImage = imageUpload.content.find((entry) => entry.type === "image");
  assert.ok(nativeImage, "direct images must return native MCP image content for same-turn ChatGPT/Work visibility");
  assert.equal(nativeImage.mimeType, "image/png");
  assert.equal(Buffer.from(nativeImage.data, "base64").compare(png), 0, "native MCP image content must remain byte-for-byte exact");
  const imageFileRef = exactFileReference(imageUpload, "original.png", "image/png", png.length);
  assert.equal(imageUpload.content.filter((entry) => entry.type === "resource_link").length, 1, "direct image should expose one exact file resource plus native image content");
  const originalResource = await client.readResource({ uri: imageFileRef.uri });
  const originalBlob = originalResource.contents[0]?.blob;
  assert.ok(originalBlob, "image resource must expose original bytes");
  assert.equal(Buffer.from(originalBlob, "base64").compare(png), 0, "model vision resource must be byte-for-byte the original image, not a thumbnail");

  const reviewZipUpload = await client.callTool({ name: "upload_local_file", arguments: { path: reviewZipPath } });
  exactFileReference(reviewZipUpload, "visual-review_two-images.zip", "application/zip", reviewZip.length);
  assert.equal(reviewZipUpload._meta?.file_transfer?.delivery_mode, "review_resources", "recognized review ZIP must stay resource-only and never enter Library upload");
  const reviewZipLinks = reviewZipUpload.content.filter((entry) => entry.type === "resource_link" && entry.uri !== reviewZipUpload.structuredContent.resource_uri);
  assert.equal(reviewZipLinks.length, 2, "one visual-review ZIP must expose every manifest-declared image in addition to the ZIP file reference");
  assert.deepEqual(reviewZipLinks.map((entry) => entry.name), ["asset-a.png", "asset-b.png"]);
  const reviewZipExpected = [zipPngA, zipPngB];
  for (let index = 0; index < reviewZipLinks.length; index += 1) {
    const memberResource = await client.readResource({ uri: reviewZipLinks[index].uri });
    const memberBlob = memberResource.contents[0]?.blob;
    assert.ok(memberBlob, "visual-review ZIP member must resolve as native image resource bytes");
    assert.equal(Buffer.from(memberBlob, "base64").compare(reviewZipExpected[index]), 0, "visual-review ZIP member must remain byte-for-byte exact");
  }

  const p3ZipUpload = await client.callTool({ name: "upload_local_file", arguments: { path: p3ReviewZipPath } });
  exactFileReference(p3ZipUpload, "p3-visual-review_test.zip", "application/zip", p3ReviewZip.length);
  const p3ZipLinks = p3ZipUpload.content.filter((entry) => entry.type === "resource_link" && entry.uri !== p3ZipUpload.structuredContent.resource_uri);
  assert.deepEqual(p3ZipLinks.map((entry) => entry.name), ["contact-sheet.png", "keyframe.png"], "P3 review ZIP must expose image review media without mislabeling the video as image evidence");
  for (let index = 0; index < p3ZipLinks.length; index += 1) {
    const memberResource = await client.readResource({ uri: p3ZipLinks[index].uri });
    const memberBlob = memberResource.contents[0]?.blob;
    assert.ok(memberBlob, "P3 review ZIP image must resolve as native image resource bytes");
    assert.equal(Buffer.from(memberBlob, "base64").compare(reviewZipExpected[index]), 0, "P3 review ZIP image must remain byte-for-byte exact");
  }

  const tiny3dZipUpload = await client.callTool({ name: "upload_local_file", arguments: { path: tiny3dReviewZipPath } });
  exactFileReference(tiny3dZipUpload, "tiny3d-visual-review_test.zip", "application/zip", tiny3dReviewZip.length);
  const tiny3dLinks = tiny3dZipUpload.content.filter((entry) => entry.type === "resource_link" && entry.uri !== tiny3dZipUpload.structuredContent.resource_uri);
  assert.equal(tiny3dLinks.length, 12);
  assert.equal(tiny3dLinks[0].name, `${"a".repeat(64)}_view_00.png`);
  for (let index = 0; index < tiny3dLinks.length; index += 1) {
    const memberResource = await client.readResource({ uri: tiny3dLinks[index].uri });
    const memberBlob = memberResource.contents[0]?.blob;
    assert.ok(memberBlob, "Tiny3D review ZIP image must resolve as native image resource bytes");
    assert.equal(Buffer.from(memberBlob, "base64").compare(tiny3dViews[index].data), 0, "Tiny3D review ZIP image must remain byte-for-byte exact");
  }
  const genericZipUpload = await client.callTool({ name: "upload_local_file", arguments: { path: genericZipPath } });
  assert.notEqual(genericZipUpload.isError, true, "generic ZIP must be allowed through the exact native file-reference path");
  exactFileReference(genericZipUpload, "generic.zip", "application/zip", genericZip.length);
  assert.equal(genericZipUpload._meta?.file_transfer?.delivery_mode, "resource_only", "generic ZIP stays native resource-only instead of invoking unsupported Library ZIP upload");
  assert.equal(genericZipUpload.content.filter((entry) => entry.type === "resource_link").length, 1, "generic ZIP returns only its exact file reference and invents no review resources");

  const videoUpload = await client.callTool({ name: "upload_local_file", arguments: { path: mediaPath } });
  assert.equal(videoUpload.content.some((entry) => entry.type === "image"), false, "video upload must not masquerade as image content");
  exactFileReference(videoUpload, "proof.mp4", "video/mp4", media.length);
  assert.equal(videoUpload._meta?.file_transfer?.delivery_mode, "library_upload", "video uses the proven HTTPS Library path while keeping its native file reference");

  const textUpload = await client.callTool({ name: "upload_local_file", arguments: { path: textPath } });
  exactFileReference(textUpload, "compressible.txt", "text/plain", text.length);
  assert.equal(textUpload._meta?.file_transfer?.delivery_mode, "library_upload");
  assert.equal(textUpload.content.filter((entry) => entry.type === "resource_link").length, 1, "non-image uploads return one exact file reference without image resources");

  const resource = await client.readResource({ uri: FILE_TRANSFER_WIDGET_URI });
  const resourceHtml = String(resource.contents[0]?.text || "");
  assert.match(resourceHtml, /FILE_TRANSFER_READY/);
  assert.match(resourceHtml, /window\.openai\.uploadFile\(file,\{library:true\}\)/);
} finally {
  await client.close();
  await server.close();
}

const widget = fileTransferWidgetHtml();
assert.match(widget, /FILE_TRANSFER_READY/);
assert.match(widget, /BYTE_COUNT_MISMATCH/);
assert.match(widget, /SHA256_MISMATCH/);
assert.match(widget, /window\.openai\.uploadFile\(file,\{library:true\}\)/);
assert.match(widget, /delivery_mode==='review_resources'/);
assert.match(widget, /delivery_mode==='resource_only'/);
assert.match(widget, /setWidgetState/);
assert.match(widget, /ui\/notifications\/tool-result/);

console.log("PASS lossless file transfer: native exact file refs plus upload_local_file-only HTTPS Library persistence, native image visibility, ZIP resource-only handling, raw bytes, zstd, native file params");
