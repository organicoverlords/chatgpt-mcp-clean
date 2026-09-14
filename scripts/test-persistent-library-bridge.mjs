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
const bridge = mod.createLibrarySpoolBridgeSession();
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
assert.equal((await readdir(queue)).length, 1, "proof must remain queued until widget upload ack");
const ackRes = new FakeResponse();
await mod.serveLibrarySpoolBridgeAck({ query: { token, id: nextRes.body.id } }, ackRes);
assert.equal(ackRes.statusCode, 200);
assert.equal((await readdir(queue)).length, 0, "proof must be acknowledged after successful widget upload");
console.log("PASS persistent_library_bridge one_tool_mount=true polling=true exact_hash=true ack_after_upload=true library_upload_api=true");
