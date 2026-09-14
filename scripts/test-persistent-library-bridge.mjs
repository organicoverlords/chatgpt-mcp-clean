import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
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
assert.doesNotMatch(html, /sleep\(Number\(b\.poll_ms\)/, "mounted bridge must not short-poll while idle");
assert.doesNotMatch(html, /VISUAL_PROOF_BRIDGE_READY/, "idle bridge must be visually silent");
assert.match(html, /ui\/message/);
assert.match(html, /VISUAL_PROOF_BRIDGE_ACK_ERROR/, 'ACK failures must retry without re-sending ui/message');
assert.doesNotMatch(html, /type:'resource_link'/, 'bridge hot path must not rely on lazy resource links for vision');
assert.doesNotMatch(html, /RESOURCE_URI_MISSING/);
assert.match(html, /await uploadTransfer\(next\.file_transfer/, 'spool hot loop must upload each proof into ChatGPT Library');
assert.match(html, /uploadFile\(file,\{library:true\}\)/, 'bridge upload must persist the verified bytes into ChatGPT Library');
assert.match(html, /sendProofMessage\(next\.file_transfer,next\.id\|\|next\.file_transfer\.file_name,fileId\)/, 'model notification must happen only after Library upload returns a file id');
const { createServer } = await import("../dist/server.js");
const server = createServer("persistent-bridge-test");
const startMeta = server._registeredTools.start_process?._meta || {};
assert.equal(startMeta["openai/outputTemplate"], undefined, "start_process must remain widget-free");
const readTool = server._registeredTools.read_output;
assert.equal(readTool?._meta?.["openai/outputTemplate"], undefined, "ordinary read_output must stay widget-free in bridge runtime");
assert.equal(server._registeredTools.upload_local_file?._meta?.["openai/outputTemplate"], "ui://process/file-transfer-v8.html", "existing upload_local_file action must bootstrap the bridge when new tool registration is filtered by the host");
const uploadBootstrap = await server._registeredTools.upload_local_file.handler({ path: filePath }, {});
assert.ok(uploadBootstrap._meta?.library_spool_bridge, "bridge-runtime upload_local_file must return a persistent bridge session");
assert.equal((await readdir(queue)).length, 1, "upload bootstrap must not consume queued proof before widget acknowledgement");
const mountTool = server._registeredTools.mount_visual_proof_bridge;
assert.equal(mountTool?._meta?.["openai/outputTemplate"], "ui://process/file-transfer-v8.html", "only the dedicated mount action may mount the persistent widget");
const legacyMount = await readTool.handler({ process_id: "visual-proof" }, {});
assert.ok(legacyMount._meta?.library_spool_bridge, "stale read_output descriptors must still receive one bridge session for visual-proof only");
assert.match(legacyMount.structuredContent?.stdout || "", /^VISUAL_PROOF_BRIDGE=\{.*"next_url".*"ack_url".*\}\n$/, "visual-proof read must expose one compact direct handoff session to the model");
assert.equal((await readdir(queue)).length, 1, "legacy bridge mount must not consume queued proof");
const mount = await mountTool.handler({}, {});
assert.equal((await readdir(queue)).length, 1, "mount must not consume queued proof");
assert.equal(mount.content.filter((item) => item?.type === "resource_link").length, 0, "mount itself must not hand off a proof resource");
const bridge = mount._meta?.library_spool_bridge;
assert.ok(bridge, "visual-proof read must return one bridge session");
assert.match(bridge.next_url, /^https:\/\/bridge\.example\.test\/visual-proof\/library-bridge\/next\?token=/);
class FakeRequest extends EventEmitter {
  constructor(query){ super(); this.query=query; }
}
class FakeResponse extends EventEmitter {
  constructor(){ super(); this.statusCode=200; this.headers={}; this.body=null; }
  setHeader(k,v){ this.headers[k]=v; return this; }
  status(n){ this.statusCode=n; return this; }
  send(v){ this.body=v; return this; }
  end(){ return this; }
  json(v){ this.body=v; return this; }
}
const token = new URL(bridge.next_url).searchParams.get("token");
const nextRes = new FakeResponse();
await mod.serveLibrarySpoolBridgeNext(new FakeRequest({ token }), nextRes);
assert.equal(nextRes.statusCode, 200);
assert.equal(nextRes.body.status, "ready");
assert.equal(nextRes.body.file_transfer.bytes, png.length);
assert.equal(nextRes.body.file_transfer.sha256, sha256);
assert.match(nextRes.body.file_transfer.transfer_url, /^https:\/\/bridge\.example\.test\/file-transfer\/local\?token=/);
assert.match(nextRes.body.file_transfer.resource_uri, /^mcp-upload:\/\/file-transfer\//);
assert.equal((await readdir(queue)).length, 0, "proof must leave the shared queue as soon as one bridge session atomically claims it");
const staleAckRes = new FakeResponse();
await mod.serveLibrarySpoolBridgeAck(new FakeRequest({ token, id: nextRes.body.id }), staleAckRes);
assert.equal(staleAckRes.statusCode, 400, "stale widgets without uploaded file id must not consume proofs");
assert.equal((await readdir(queue)).length, 0, "stale acknowledgement must not return an exclusively claimed proof to the shared queue");
const secondMount = await mountTool.handler({}, {});
const secondBridge = secondMount._meta?.library_spool_bridge;
const secondToken = new URL(secondBridge.next_url).searchParams.get("token");
const secondReq = new FakeRequest({ token: secondToken });
const secondRes = new FakeResponse();
let secondResolved = false;
const secondWait = mod.serveLibrarySpoolBridgeNext(secondReq, secondRes).then(() => { secondResolved = true; });
await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(secondResolved, false, "a second bridge process/session must not observe an artifact already claimed by the first");
const ackRes = new FakeResponse();
await mod.serveLibrarySpoolBridgeAck(new FakeRequest({ token, id: nextRes.body.id, file_id: "file_bridge_acceptance" }), ackRes);
assert.equal(ackRes.statusCode, 200);
const duplicateAckRes = new FakeResponse();
await mod.serveLibrarySpoolBridgeAck(new FakeRequest({ token, id: nextRes.body.id, file_id: "file_bridge_acceptance" }), duplicateAckRes);
assert.equal(duplicateAckRes.statusCode, 200, "lost ACK responses must be safe to retry");
assert.equal(duplicateAckRes.body?.replayed, true, "duplicate ACK must be recognized rather than consuming another proof");
assert.equal((await readdir(queue)).length, 0, "proof must remain absent from the shared queue after acknowledgement");

const idleReq = new FakeRequest({ token });
const idleRes = new FakeResponse();
let idleResolved = false;
const idleWait = mod.serveLibrarySpoolBridgeNext(idleReq, idleRes).then(() => { idleResolved = true; });
await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(idleResolved, false, "idle bridge next request must stay open instead of returning 204 for client polling");
assert.equal(idleRes.body, null);

await writeFile(join(queue, "0002.json"), JSON.stringify({ path: filePath, bytes: png.length, sha256 }));
await Promise.race([
  Promise.all([secondWait, idleWait]),
  new Promise((_, reject) => setTimeout(() => reject(new Error("bridge sessions did not settle after a new artifact")), 2000)),
]);
const ready = [
  { token: secondToken, res: secondRes },
  { token, res: idleRes },
].filter(({ res }) => res.statusCode === 200 && res.body?.status === "ready");
const missed = [secondRes, idleRes].filter((res) => res.statusCode === 204);
assert.equal(ready.length, 1, "one artifact must be claimed by exactly one bridge session");
assert.equal(missed.length, 1, "the losing bridge session must return 204 after losing the atomic claim");
assert.equal(ready[0].res.body?.id, "0002.json");
const winnerAck = new FakeResponse();
await mod.serveLibrarySpoolBridgeAck(new FakeRequest({ token: ready[0].token, id: ready[0].res.body.id, file_id: "file_bridge_race2" }), winnerAck);
assert.equal(winnerAck.statusCode, 200);

const loserToken = ready[0].token === token ? secondToken : token;
const loserRes = new FakeResponse();
const loserNext = mod.serveLibrarySpoolBridgeNext(new FakeRequest({ token: loserToken }), loserRes);
await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(loserRes.body, null, "losing bridge may long-poll again after its 204");
await writeFile(join(queue, "0003.json"), JSON.stringify({ path: filePath, bytes: png.length, sha256 }));
await Promise.race([loserNext, new Promise((_, reject) => setTimeout(() => reject(new Error("remaining bridge did not wake for the next artifact")), 2000))]);
assert.equal(loserRes.statusCode, 200);
assert.equal(loserRes.body?.id, "0003.json");
assert.equal(loserRes.body.file_transfer.sha256, sha256);
const loserAck = new FakeResponse();
await mod.serveLibrarySpoolBridgeAck(new FakeRequest({ token: loserToken, id: loserRes.body.id, file_id: "file_bridge_race3" }), loserAck);
assert.equal(loserAck.statusCode, 200);
assert.equal((await readdir(queue)).length, 0);

const abandonedDir = join(spool, "claimed", "abandoned.json.claim");
await mkdir(abandonedDir, { recursive: true });
await writeFile(join(abandonedDir, "owner.meta"), JSON.stringify({ pid: 999999, claimedAt: 0 }));
await writeFile(join(abandonedDir, "abandoned.json"), JSON.stringify({ path: filePath, bytes: png.length, sha256 }));
const recoveredRes = new FakeResponse();
await mod.serveLibrarySpoolBridgeNext(new FakeRequest({ token: loserToken }), recoveredRes);
assert.equal(recoveredRes.statusCode, 200);
assert.equal(recoveredRes.body?.id, "abandoned.json", "dead-owner claim must be recovered after backend restart/crash");
const recoveredAck = new FakeResponse();
await mod.serveLibrarySpoolBridgeAck(new FakeRequest({ token: loserToken, id: recoveredRes.body.id, file_id: "file_bridge_recovered" }), recoveredAck);
assert.equal(recoveredAck.statusCode, 200);
assert.equal((await readdir(queue)).length, 0);
console.log("PASS persistent_visual_bridge mount_action=mount_visual_proof_bridge start_widget=false mount_consumes_proof=false idle_http_polling=false long_poll=true exact_hash=true resource_message=false library_upload=true per_proof_upload=true exclusive_claim=true crash_recovery=true idempotent_ack=true ack_after_message=true");
