import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { recordStagingReview, registerVisualProofReviewTools, resolveStagingProof, stagingProofToolResult } from "../dist/lib/visual-proof-review.js";

const digest = (data) => createHash("sha256").update(data).digest("hex");
const root = await mkdtemp(join(tmpdir(), "proof-review-stage-"));
const fakeRepo = await mkdtemp(join(tmpdir(), "proof-review-repo-"));
await mkdir(join(fakeRepo, "scripts"), {recursive:true});
await writeFile(join(fakeRepo, "scripts", "Publish-P3ReviewedVisualEvidence.ps1"), "# fixture path only\n");

async function makeRun(id, bytes = Buffer.from("exact-proof-image"), extra = {}) {
  const run = join(root, id);
  await mkdir(run, {recursive:true});
  await writeFile(join(run, "proof.png"), bytes);
  const manifest = {
    schema:"p3.visual-evidence.v1", mode:"Screenshot", actor:"producer-worker",
    claim:"The intended runtime subject is visibly present and readable.", map:"/Game/V2/Maps/Lvl_V2ProductionWorld",
    primary:{path:"C:\\producer\\proof.png",sha256:digest(bytes),bytes:bytes.length}, ...extra,
  };
  await writeFile(join(run,"manifest.json"), JSON.stringify(manifest));
  return {run,bytes,manifest};
}

const good = await makeRun("run-good");
const opened = await resolveStagingProof("run-good", {stagingRoot:root});
assert.equal(opened.imageSha256,digest(good.bytes));
assert.deepEqual(opened.image,good.bytes);
assert.equal(opened.reviewed,null);

const result = await stagingProofToolResult("run-good", {stagingRoot:root});
assert.equal(result.structuredContent.identity,"run-good");
assert.equal(result.structuredContent.independent_review_state,"PENDING_REVIEW");
const imageContent = result.content.find((item)=>item.type==="image");
assert.ok(imageContent);
assert.deepEqual(Buffer.from(imageContent.data,"base64"),good.bytes);
assert.equal(digest(Buffer.from(imageContent.data,"base64")),result.structuredContent.image.sha256);

await assert.rejects(()=>resolveStagingProof("../outside",{stagingRoot:root}),/RUN_ID_INVALID/);
const missingHash = await makeRun("run-missing-hash",Buffer.from("missing-hash"),{primary:{path:"proof.png",bytes:12}});
await assert.rejects(()=>resolveStagingProof("run-missing-hash",{stagingRoot:root}),/SHA_REQUIRED/);
const tampered = await makeRun("run-tampered",Buffer.from("before"));
await writeFile(join(tampered.run,"proof.png"),Buffer.from("after"));
await assert.rejects(()=>resolveStagingProof("run-tampered",{stagingRoot:root}),/IMAGE_(SIZE|HASH)_MISMATCH/);

const outside = await mkdtemp(join(tmpdir(),"proof-review-outside-"));
await writeFile(join(outside,"manifest.json"),JSON.stringify(good.manifest));
let junctionMade=false;
try {
  await symlink(outside,join(root,"run-escape"),process.platform==="win32"?"junction":"dir");
  junctionMade=true;
} catch (error) {
  if (!(["EPERM","EACCES","ENOTSUP"].includes(error?.code))) throw error;
}
if (junctionMade) await assert.rejects(()=>resolveStagingProof("run-escape",{stagingRoot:root}),/PATH_ESCAPE/);

const fakePublisher = async (args) => {
  const value = (name) => {
    const index=args.indexOf(name);
    assert.ok(index>=0,`publisher arg missing: ${name}`);
    return args[index+1];
  };
  const runPath=value("-RunPath");
  const manifest=JSON.parse(await readFile(join(runPath,"manifest.json"),"utf8"));
  const image=await readFile(join(runPath,"proof.png"));
  assert.equal(value("-Reviewer"),"independent-worker");
  assert.equal(value("-ExpectedMap"),manifest.map);
  assert.equal(value("-Claim"),manifest.claim);
  assert.equal(value("-VisualVerdict"),"PROVEN");
  const review={
    schema:"p3.visual-evidence-review.v3",reviewed_utc:new Date().toISOString(),reviewer:value("-Reviewer"),
    observed_label:value("-ObservedLabel"),review_status:value("-VisualVerdict"),
    visual_review:{verdict:value("-VisualVerdict"),claim:value("-Claim"),evidence_window:value("-EvidenceWindow"),inspection_mode:value("-InspectionMode"),identity_check:value("-IdentityCheck"),quality_check:value("-QualityCheck"),findings:value("-VisualFindings")},
    reviewed_primary:join(runPath,"proof.png"),reviewed_primary_sha256:digest(image),reviewed_image:join(runPath,"proof.png"),reviewed_image_sha256:digest(image),manifest:join(runPath,"manifest.json"),run_path:runPath,
  };
  await writeFile(join(runPath,"reviewed.json"),"\uFEFF"+JSON.stringify(review));
  return JSON.stringify(review);
};
const reviewInput={
  run_id:"run-good", expected_image_sha256:digest(good.bytes), observed_label:"Readable intended runtime subject", reviewer:"independent-worker",
  expected_map:good.manifest.map, claim:good.manifest.claim, evidence_window:"single captured frame",
  visual_verdict:"PROVEN", inspection_mode:"INSPECTED_FRAME_SEQUENCE", identity_check:"MATCH", quality_check:"GOOD",
  visual_findings:"The exact captured pixels clearly show the intended runtime subject with readable presentation.",
};
const review=await recordStagingReview(reviewInput,{stagingRoot:root,p3RepoRoot:fakeRepo,publisherRunner:fakePublisher});
assert.equal(review.review_status,"PROVEN");
assert.equal(review.reviewed_image_sha256,digest(good.bytes));
const reopened=await resolveStagingProof("run-good",{stagingRoot:root});
assert.equal(reopened.reviewed.review_status,"PROVEN");
await assert.rejects(()=>recordStagingReview(reviewInput,{stagingRoot:root,p3RepoRoot:fakeRepo,publisherRunner:fakePublisher}),/ALREADY_RECORDED/);

const wrongShaRun=await makeRun("run-wrong-expected",Buffer.from("expected-sha-guard"));
await assert.rejects(()=>recordStagingReview({...reviewInput,run_id:"run-wrong-expected",expected_image_sha256:"0".repeat(64)},{stagingRoot:root,p3RepoRoot:fakeRepo,publisherRunner:fakePublisher}),/EXPECTED_SHA_MISMATCH/);

const oldStage=process.env.P3_VISUAL_PROOF_STAGING_ROOT;
process.env.P3_VISUAL_PROOF_STAGING_ROOT=root;
const server=new McpServer({name:"visual-review-test",version:"1.0.0"});
registerVisualProofReviewTools(server,"caller_test");
const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client=new Client({name:"visual-review-client",version:"1.0.0"});
await client.connect(clientTransport);
const tools=await client.listTools();
assert.ok(tools.tools.some((tool)=>tool.name==="open_visual_proof_run"));
assert.ok(tools.tools.some((tool)=>tool.name==="record_visual_proof_review"));
const mcpOpen=await client.callTool({name:"open_visual_proof_run",arguments:{run_id:"run-good"}});
assert.equal(mcpOpen.structuredContent.identity,"run-good");
assert.equal(mcpOpen.structuredContent.independent_review_state,"PROVEN");
await client.close();
await server.close();
if (oldStage===undefined) delete process.env.P3_VISUAL_PROOF_STAGING_ROOT; else process.env.P3_VISUAL_PROOF_STAGING_ROOT=oldStage;

console.log(JSON.stringify({schema:"visual-proof-review-test.v1",status:"PASS",junction_escape_tested:junctionMade,image_sha256:digest(good.bytes)}));

