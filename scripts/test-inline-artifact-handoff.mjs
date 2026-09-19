import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../dist/server.js";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=", "base64");
const local = await mkdtemp(join(tmpdir(), "mcp-inline-artifact-"));
const pngA = join(local, "frame-a.png");
const pngB = join(local, "frame-b.png");
const video = join(local, "capture.mp4");
await writeFile(pngA, PNG_1X1);
await writeFile(pngB, PNG_1X1);
await writeFile(video, Buffer.from("000000186674797069736F6D", "hex"));

const server = createServer("inline-artifact-test", { backend_generation: "inline-test", source_commit: "0123456789abcdef0123456789abcdef01234567" });
assert.deepEqual(Object.keys(server._registeredTools).sort(), ["kill_process", "read_output", "start_process"]);
for (const forbidden of ["view_image", "upload_local_file", "read_local_file", "mount_visual_proof_bridge"]) {
  assert.equal(server._registeredTools[forbidden], undefined, `${forbidden} must not be exposed`);
}

function mediaEntries(result) { return result.content; }
function imageEntries(result) { return mediaEntries(result).filter((entry) => entry.type === "image"); }
function resolutionEntries(result) { return mediaEntries(result).filter((entry) => entry.type === "text" && /^resolution: \d+x\d+$/.test(entry.text)); }

const directCode = `console.log('CHATGPT_ARTIFACT='+${JSON.stringify(pngA)})`;
const direct = await server._registeredTools.start_process.handler({ executable: process.execPath, args: ["-e", directCode], wait_ms: 2000 }, {});
assert.equal(imageEntries(direct).length, 1);
assert.equal(imageEntries(direct)[0].mimeType, "image/png");
assert.deepEqual(Buffer.from(imageEntries(direct)[0].data, "base64"), PNG_1X1, "inline image must be the original bytes");
assert.deepEqual(resolutionEntries(direct).map((entry) => entry.text), ["resolution: 1x1"]);
assert.equal(mediaEntries(direct).some((entry) => entry.type === "resource_link"), false, "direct image must not require a second resource read");
assert.equal(mediaEntries(direct).some((entry) => entry.type === "text" && /sha256/i.test(entry.text)), false, "image handoff must not report hashes");

const legacyCode = `console.log('CHATGPT_LIBRARY_UPLOAD='+${JSON.stringify(pngA)})`;
const legacy = await server._registeredTools.start_process.handler({ executable: process.execPath, args: ["-e", legacyCode], wait_ms: 2000 }, {});
assert.equal(imageEntries(legacy).length, 1, "legacy capture producers must keep working during rollout");

const streamCode = `setTimeout(()=>console.log('CHATGPT_ARTIFACT='+${JSON.stringify(pngA)}),120);setTimeout(()=>console.log('CHATGPT_ARTIFACT='+${JSON.stringify(pngB)}),220);setTimeout(()=>{},350);`;
const started = await server._registeredTools.start_process.handler({ executable: process.execPath, args: ["-e", streamCode], wait_ms: 0 }, {});
assert.equal(started.structuredContent.running, true);
const streamedA = await server._registeredTools.read_output.handler({ process_id: started.structuredContent.process_id, max_chars: 32000, wait_ms: 1000 }, {});
assert.equal(imageEntries(streamedA).length, 1, "first output revision must carry the first marked screenshot");
assert.deepEqual(resolutionEntries(streamedA).map((entry) => entry.text), ["resolution: 1x1"]);
const streamedB = await server._registeredTools.read_output.handler({ process_id: started.structuredContent.process_id, max_chars: 32000, wait_ms: 1000 }, {});
assert.equal(imageEntries(streamedB).length, 1, "next output revision must carry the next marked screenshot without replaying the first");
assert.deepEqual(resolutionEntries(streamedB).map((entry) => entry.text), ["resolution: 1x1"]);
for (const entry of [...imageEntries(streamedA), ...imageEntries(streamedB)]) assert.deepEqual(Buffer.from(entry.data, "base64"), PNG_1X1);

const jsonCode = `console.log(JSON.stringify({chatgpt_artifacts:[${JSON.stringify(pngA)},${JSON.stringify(pngB)}],status:'ok'}))`;
const jsonDeclared = await server._registeredTools.start_process.handler({ executable: process.execPath, args: ["-e", jsonCode], wait_ms: 2000 }, {});
assert.equal(imageEntries(jsonDeclared).length, 2, "machine-readable JSON results may declare review artifacts without corrupting stdout");
assert.deepEqual(resolutionEntries(jsonDeclared).map((entry) => entry.text), ["resolution: 1x1", "resolution: 1x1"]);

const videoCode = `console.log('CHATGPT_ARTIFACT='+${JSON.stringify(video)})`;
const videoResult = await server._registeredTools.start_process.handler({ executable: process.execPath, args: ["-e", videoCode], wait_ms: 2000 }, {});
assert.equal(imageEntries(videoResult).length, 0, "video must not masquerade as an image");
assert.equal(mediaEntries(videoResult).filter((entry) => entry.type === "resource_link").length, 1, "video remains an ordinary artifact while keyframes/contact sheets are marked separately");

await rm(local, { recursive: true, force: true });
console.log("PASS inline_artifact_handoff three_tools=true direct_fullres=true read_output_stream=true multi_keyframe=true legacy_marker=true video_resource=true");
