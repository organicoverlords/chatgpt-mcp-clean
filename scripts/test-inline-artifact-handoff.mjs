import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=", "base64");
const local = await mkdtemp(join(tmpdir(), "mcp-inline-image-"));
process.env.MCP_IMAGE_ROOTS = local;
const png = join(local, "frame.png");
const oversizedPng = join(local, "oversized.png");
await writeFile(png, PNG_1X1);
const oversizedBytes = Buffer.alloc(10 * 1024 * 1024);
PNG_1X1.copy(oversizedBytes);
await writeFile(oversizedPng, oversizedBytes);

const { createServer } = await import("../dist/server.js");
const server = createServer("inline-image-test", { backend_generation: "inline-test", source_commit: "0123456789abcdef0123456789abcdef01234567" });
assert.deepEqual(Object.keys(server._registeredTools).sort(), ["inspect_image", "kill_process", "read_output", "start_process"]);
for (const forbidden of ["view_image", "upload_local_file", "read_local_file", "mount_visual_proof_bridge"]) {
  assert.equal(server._registeredTools[forbidden], undefined, `${forbidden} must not be exposed`);
}
assert.equal(server._registeredResources?.["file-transfer-resource"], undefined, "file materialization resource must not be registered");

const artifactCode = `console.log('CHATGPT_ARTIFACT='+${JSON.stringify(png)})`;
const artifactResult = await server._registeredTools.start_process.handler({ executable: process.execPath, args: ["-e", artifactCode], wait_ms: 2000 }, {});
assert.deepEqual(artifactResult.content, [], "process results must never auto-attach artifact/image/resource content");
assert.match(String(artifactResult.structuredContent.stdout || ""), /CHATGPT_ARTIFACT=/, "marker remains ordinary process output for legacy producers");

const inspected = await server._registeredTools.inspect_image.handler({ path: png, execution_target: "local" }, {});
assert.equal(inspected.content.length, 2);
assert.equal(inspected.content[0].type, "text");
assert.equal(inspected.content[1].type, "image");
assert.equal(inspected.content[1].mimeType, "image/png");
assert.deepEqual(Buffer.from(inspected.content[1].data, "base64"), PNG_1X1, "inspect_image must return the exact original bytes");
assert.equal(inspected.content.some((entry) => entry.type === "resource_link" || entry.type === "resource"), false, "inspect_image must not materialize a file/resource");

await assert.rejects(
  () => server._registeredTools.inspect_image.handler({ path: oversizedPng, execution_target: "local" }, {}),
  /strictly less than 10485760 bytes/,
  "images at the 10 MiB boundary must be rejected before model vision",
);

await rm(local, { recursive: true, force: true });
console.log("PASS inline_image_inspection tools=4 no_materialization=true exact_inline_image=true strict_10mib_cap=true");
