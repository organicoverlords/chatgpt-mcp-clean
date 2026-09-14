import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const local = await mkdtemp(join(tmpdir(), "mcp-library-bridge-"));
process.env.LOCALAPPDATA = local;
process.env.MCP_PUBLIC_ORIGIN = "https://bridge.example.test/";
process.env.MCP_LIBRARY_SPOOL_BRIDGE = "1";
process.env.MCP_LOCAL_FILE_TOOL_NAME = "upload_local_file";
const spool = join(local, "ChatGPTMcpFrozen", "handoff-spool");
const queue = join(spool, "queue");
await mkdir(queue, { recursive: true });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7WQAAAAASUVORK5CYII=", "base64");
const filePath = join(spool, "proof.png");
await writeFile(filePath, png);
const sha256 = createHash("sha256").update(png).digest("hex");
await writeFile(join(queue, "0001.json"), JSON.stringify({ path: filePath, bytes: png.length, sha256 }));
const mod = await import("../dist/lib/file-transfer.js");
const html = mod.fileTransferWidgetHtml();
assert.match(html, /window\.openai\?\.uploadFile/);
assert.match(html, /bridgeLoop/);
assert.match(html, /ui\/message/);
assert.match(html, /type:'resource_link'/);
assert.match(html, /RESOURCE_URI_MISSING/);
assert.doesNotMatch(html, /await uploadTransfer\(next\.file_transfer/, 'spool hot loop must not re-upload each proof through Library');
const { createServer } = await import("../dist/server.js");
const server = createServer("persistent-bridge-test");
const startMeta = server._registeredTools.start_process?._meta || {};
assert.equal(startMeta["openai/outputTemplate"], undefined, "start_process must remain widget-free");
const readTool = server._registeredTools.read_output;
assert.equal(readTool?._meta?.["openai/outputTemplate"], "ui://process/file-transfer-v7.html", "bridge candidate must mount the persistent widget through cached read_output");
const mount = await readTool.handler({ process_id: "visual-proof" }, {});
assert.equal((await readdir(queue)).length, 1, "mount must not consume queued proof");
assert.equal(mount.content.filter((item) => item?.type === "resource_link").length, 0, "mount itself must not hand off a proof resource");
const bridge = mount._meta?.library_spool_bridge;
assert.ok(bridge, "visual-proof read must return one bridge session");
assert.match(bridge.next_url, /^https:\/\/bridge\.example\.test\/visual-proof\/library-bridge\/next\?token=/);
class FakeResponse {
  constructor(){ this.statusCode=200; this.headers={}; this.body=null; }
  setHeader(k,v){ this.headers[k]=v; return this; }
  status(n){ this.statusCode=n; return this; }
  send(v){ this.body=v; return this; }
  end(){ return this; }
  json(v){ this.body=v; return this; }
}
const token = new URL(bridge.next_url).searchParams.get("token");
const nextRes = new FakeResponse();
await mod.serveLibrarySpoolBridgeNext({ query: { token } }, nextRes);
assert.equal(nextRes.statusCode, 200);
assert.equal(nextRes.body.status, "ready");
assert.equal(nextRes.body.file_transfer.bytes, png.length);
assert.equal(nextRes.body.file_transfer.sha256, sha256);
assert.match(nextRes.body.file_transfer.transfer_url, /^https:\/\/bridge\.example\.test\/file-transfer\/local\?token=/);
assert.match(nextRes.body.file_transfer.resource_uri, /^mcp-upload:\/\/file-transfer\//);
assert.equal((await readdir(queue)).length, 1, "proof must remain queued until widget upload ack");
const ackRes = new FakeResponse();
await mod.serveLibrarySpoolBridgeAck({ query: { token, id: nextRes.body.id } }, ackRes);
assert.equal(ackRes.statusCode, 200);
assert.equal((await readdir(queue)).length, 0, "proof must be acknowledged after successful widget upload");
console.log("PASS persistent_visual_bridge mount_action=read_output start_widget=false mount_consumes_proof=false polling=true exact_hash=true resource_message=true per_proof_upload=false ack_after_message=true");
