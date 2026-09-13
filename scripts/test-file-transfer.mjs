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

mediaItem.transfer_expires_at = Date.now() - 1;
const expiredTransfer = await serve(mediaItem, "identity");
assert.equal(expiredTransfer.statusCode, 404, "browser transfer capability must expire independently of the MCP resource");

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
assert.equal(FILE_TRANSFER_WIDGET_URI, "ui://process/file-transfer-v7.html", "legacy compatibility URI remains readable while upload_local_file is widget-free");
  const start = listed.tools.find((tool) => tool.name === "start_process");
  const read = listed.tools.find((tool) => tool.name === "read_output");
  const upload = listed.tools.find((tool) => tool.name === "upload_local_file");
  const download = listed.tools.find((tool) => tool.name === "download_chatgpt_file");
  assert.ok(start?.inputSchema?.properties?.command, "start_process must expose legacy command input");
  assert.ok(start?.inputSchema?.properties?.executable, "start_process must expose structured executable input");
  assert.ok(start?.inputSchema?.properties?.args, "start_process must expose structured argv input");
  assert.ok(start?.inputSchema?.properties?.stdin, "start_process must expose structured stdin input");
  for (const [name, tool] of [["start_process", start], ["read_output", read]]) {
    assert.equal(tool?._meta?.["openai/outputTemplate"], undefined, `${name} must not mount a widget`);
    assert.equal(tool?._meta?.["ui/resourceUri"], undefined, `${name} must not advertise a widget resource`);
    assert.equal(tool?._meta?.ui, undefined, `${name} must not advertise nested widget UI metadata`);
  }
  assert.equal(upload?._meta?.ui, undefined, "upload_local_file must not advertise nested widget UI metadata");
  assert.equal(upload?._meta?.["ui/resourceUri"], undefined, "upload_local_file must not advertise a widget resource URI");
  assert.equal(upload?._meta?.["openai/outputTemplate"], undefined, "upload_local_file must not mount an app/widget");
  assert.equal(upload?._meta?.["openai/toolInvocation/invoking"], "Preparing file…");
  assert.equal(upload?._meta?.["openai/toolInvocation/invoked"], "File ready");
  assert.equal(download?._meta?.["openai/outputTemplate"], undefined, "download_chatgpt_file should use native file params, not a widget");
  assert.deepEqual(download?._meta?.["openai/fileParams"], ["file"]);
  const expiredTransferResource = await client.readResource({ uri: `mcp-upload://file-transfer/${mediaItem.token}` });
  assert.equal(Buffer.from(expiredTransferResource.contents[0]?.blob || "", "base64").compare(media), 0, "expired browser transfer must not invalidate the authenticated MCP resource");

  const fileSchema = download?.inputSchema?.properties?.file;
  assert.deepEqual(fileSchema?.required, ["download_url", "file_id"]);
  assert.deepEqual(Object.keys(fileSchema?.properties || {}).sort(), ["download_url", "file_id", "file_name", "mime_type"]);

  async function expectToolFailureWithoutTransferMeta(name, args, label) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${label} must be a tool-level failure`);
    assert.equal(result._meta, undefined, `${label} must not attach result metadata`);
    assert.equal(result.structuredContent, undefined, `${label} must not synthesize structured success content`);
    assert.equal(result.content.some((entry) => entry.type === "image" || entry.type === "resource_link"), false, `${label} must not expose image/resource content`);
    return result;
  }

  await expectToolFailureWithoutTransferMeta("read_output", { process_id: "definitely-missing-process-id" }, "missing read_output process");
  await expectToolFailureWithoutTransferMeta("kill_process", { process_id: "00000000-0000-4000-8000-000000000000" }, "missing kill_process process");
  await expectToolFailureWithoutTransferMeta("upload_local_file", { path: join(dir, "missing-image.png") }, "missing upload_local_file path");
  await expectToolFailureWithoutTransferMeta("download_chatgpt_file", { file: { download_url: "https://127.0.0.1/private", file_id: "file_bad", file_name: "bad.png", mime_type: "image/png" }, destination_path: join(dir, "bad.png") }, "blocked download_chatgpt_file URL");

  const missingExecutable = await client.callTool({ name: "start_process", arguments: { executable: "__definitely_missing_executable_324__", args: [], wait_ms: 10000 } });
  assert.notEqual(missingExecutable.isError, true, "spawn failure is a completed process outcome");
  assert.equal(missingExecutable._meta, undefined, "spawn failure must not attach app/widget metadata");
  assert.equal(missingExecutable.structuredContent?.execution_outcome, "error");
  assert.equal(missingExecutable.structuredContent?.failure_diagnostic?.kind, "spawn_error");
  assert.equal(missingExecutable.content.some((entry) => entry.type === "image" || entry.type === "resource_link"), false);

  const structuredNonzero = await client.callTool({ name: "start_process", arguments: { executable: process.execPath, args: ["-e", "process.exit(7)"], wait_ms: 10000 } });
  assert.notEqual(structuredNonzero.isError, true, "structured child nonzero exit is a process outcome, not an MCP transport error");
  assert.equal(structuredNonzero._meta, undefined, "structured child nonzero exit must not attach app/widget metadata");
  assert.equal(structuredNonzero.structuredContent?.exit_code, 7);
  assert.equal(structuredNonzero.content.some((entry) => entry.type === "image" || entry.type === "resource_link"), false);

  const parserNonzero = await client.callTool({ name: "start_process", arguments: { script: "if (", language: "powershell", wait_ms: 10000 } });
  assert.notEqual(parserNonzero.isError, true, "parser failure is reported as a completed process outcome");
  assert.equal(parserNonzero._meta, undefined, "parser failure must not attach app/widget metadata");
  assert.equal(parserNonzero.structuredContent?.execution_outcome, "nonzero_exit");
  assert.equal(parserNonzero.structuredContent?.failure_diagnostic?.kind, "parser_error");
  assert.equal(parserNonzero.content.some((entry) => entry.type === "image" || entry.type === "resource_link"), false);
  const invalidStart = await client.callTool({ name: "start_process", arguments: { command: "" } });
  assert.equal(invalidStart.isError, true, "schema-invalid start_process must be a tool-level failure");
  assert.equal(invalidStart._meta, undefined, "schema-invalid start_process must not attach app/widget metadata");
  assert.equal(invalidStart.content.some((entry) => entry.type === "image" || entry.type === "resource_link"), false, "schema-invalid start_process must not expose media content");
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

  const largeImagePath = join(dir, "large-noise.jpg");
  const largeImage = Buffer.alloc(9 * 1024 * 1024, 0x5a);
  await writeFile(largeImagePath, largeImage);
  const largeImageUpload = await client.callTool({ name: "upload_local_file", arguments: { path: largeImagePath } });
  assert.equal(largeImageUpload.content.some((entry) => entry.type === "image"), false, "multi-megabyte image must never inline base64 into CallToolResult");
  assert.ok(JSON.stringify(largeImageUpload).length < 32_000, "multi-megabyte image result must remain metadata-sized");
  const largeImageRef = exactFileReference(largeImageUpload, "large-noise.jpg", "image/jpeg", largeImage.length);
  const largeImageResource = await client.readResource({ uri: largeImageRef.uri });
  assert.equal(Buffer.from(largeImageResource.contents[0]?.blob || "", "base64").compare(largeImage), 0, "large image lazy resource must preserve exact full-resolution bytes");

  const imageUpload = await client.callTool({ name: "upload_local_file", arguments: { path: pngPath } });
  assert.equal(imageUpload._meta, undefined, "native image handoff must not carry widget/Library result metadata");
  assert.equal(imageUpload.content.some((entry) => entry.type === "image"), false, "direct images must not inline base64 bytes into the tool result/transcript");
  const imageFileRef = exactFileReference(imageUpload, "original.png", "image/png", png.length);
  assert.equal(imageUpload.content.filter((entry) => entry.type === "resource_link").length, 1, "direct image should expose one exact lazy resource link");
  assert.ok(JSON.stringify(imageUpload).length < 32_000, "direct image tool result must stay metadata-sized regardless of source pixels");
  const originalResource = await client.readResource({ uri: imageFileRef.uri });
  const originalBlob = originalResource.contents[0]?.blob;
  assert.ok(originalBlob, "image resource must expose original bytes");
  assert.equal(Buffer.from(originalBlob, "base64").compare(png), 0, "model vision resource must be byte-for-byte the original image, not a thumbnail");
  for (let pass = 0; pass < 32; pass += 1) {
    const repeated = await client.readResource({ uri: imageFileRef.uri });
    const repeatedBlob = repeated.contents[0]?.blob;
    assert.ok(repeatedBlob, `repeat image resource read ${pass} must remain available without rematerialization`);
    assert.equal(Buffer.from(repeatedBlob, "base64").compare(png), 0, `repeat image resource read ${pass} must preserve exact full-resolution bytes`);
  }

  const reviewZipUpload = await client.callTool({ name: "upload_local_file", arguments: { path: reviewZipPath } });
  exactFileReference(reviewZipUpload, "visual-review_two-images.zip", "application/zip", reviewZip.length);
  assert.equal(reviewZipUpload._meta, undefined, "review ZIP handoff must stay widget-free");
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
  assert.equal(genericZipUpload._meta, undefined, "generic ZIP handoff must stay widget-free");
  assert.equal(genericZipUpload.content.filter((entry) => entry.type === "resource_link").length, 1, "generic ZIP returns only its exact file reference and invents no review resources");

  const videoUpload = await client.callTool({ name: "upload_local_file", arguments: { path: mediaPath } });
  assert.equal(videoUpload.content.some((entry) => entry.type === "image"), false, "video upload must not masquerade as image content");
  exactFileReference(videoUpload, "proof.mp4", "video/mp4", media.length);
  assert.equal(videoUpload._meta, undefined, "video handoff must stay widget-free");

  const textUpload = await client.callTool({ name: "upload_local_file", arguments: { path: textPath } });
  exactFileReference(textUpload, "compressible.txt", "text/plain", text.length);
  assert.equal(textUpload._meta, undefined, "ordinary file handoff must stay widget-free");
  assert.equal(textUpload.content.filter((entry) => entry.type === "resource_link").length, 1, "non-image uploads return one exact file reference without image resources");

  const resource = await client.readResource({ uri: FILE_TRANSFER_WIDGET_URI });
  const resourceHtml = String(resource.contents[0]?.text || "");
  assert.match(resourceHtml, /FILE_TRANSFER_NATIVE_RESOURCE/);
  assert.doesNotMatch(resourceHtml, /uploadFile|setWidgetState|requestClose|toolResponseMetadata|ui\/notifications\/tool-result/, "legacy widget URI must be inert compatibility only");
} finally {
  await client.close();
  await server.close();
}

const widget = fileTransferWidgetHtml();
assert.match(widget, /FILE_TRANSFER_NATIVE_RESOURCE/);
assert.doesNotMatch(widget, /<script>|uploadFile|setWidgetState|requestClose|toolResponseMetadata|ui\/notifications\/tool-result|notifyIntrinsicHeight|imageIds/, "compatibility widget must be inert and unable to prompt, mutate widget state, or reflow chat");

console.log("PASS lossless file transfer: widget-free compact native file refs, full-resolution lazy image resources, ZIP review resources, raw bytes, zstd, native file params");
