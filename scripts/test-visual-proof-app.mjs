import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { resolveVisualProof, visualProofToolResult, visualProofWidgetHtml, registerVisualProofApp, VISUAL_PROOF_WIDGET_URI } from "../dist/lib/visual-proof-app.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const digest = (b) => createHash("sha256").update(b).digest("hex");
const p3 = await mkdtemp(join(tmpdir(), "proof-app-p3-"));
const t3d = await mkdtemp(join(tmpdir(), "proof-app-t3d-"));

const meteorDir = join(p3,"2026-09-02","p3-pr750-meteor-vfx-accepted");
const rejectedDir = join(p3,"2026-09-01","p3-pr622-meteor-rejected");
const laneDir = join(p3,"2026-09-01","p3-pr723-v2-lanewar-runtime-video");
for (const d of [meteorDir,rejectedDir,laneDir]) await mkdir(d,{recursive:true});
const meteor=Buffer.from("accepted-meteor-contact-sheet");
const rejected=Buffer.from("rejected-meteor");
const laneImage=Buffer.from("lane-contact-sheet");
const laneVideo=Buffer.from("lane-video-exact");
await writeFile(join(meteorDir,"accepted_contact-sheet.jpg"),meteor);
await writeFile(join(rejectedDir,"rejected.png"),rejected);
await writeFile(join(laneDir,"runtime-contact-sheet.png"),laneImage);
await writeFile(join(laneDir,"runtime.mp4"),laneVideo);
await writeFile(join(p3,"index-v1.json"),JSON.stringify({schema:"p3.visual-evidence-index.v1",entries:[
 {run_id:"p3-pr750-meteor-vfx-accepted",date:"2026-09-02",claim:"Meteor spell impact",independent_review_state:"PROVEN",tags:["spell","meteor","vfx"],search_text:"meteor spell /Game/V2/Maps/Lvl_V2ProductionWorld",gaps:[],media:[{path:"2026-09-02/p3-pr750-meteor-vfx-accepted/accepted_contact-sheet.jpg",bytes:meteor.length,declared_sha256:digest(meteor),declared_size_matches:true}]},
 {run_id:"p3-pr622-meteor-rejected",date:"2026-09-01",claim:"Rejected meteor",independent_review_state:"REJECTED",search_text:"meteor /Game/V2/Maps/Lvl_V2ProductionWorld",gaps:[],media:[{path:"2026-09-01/p3-pr622-meteor-rejected/rejected.png",bytes:rejected.length,declared_sha256:digest(rejected),declared_size_matches:true}]},
 {run_id:"p3-pr723-v2-lanewar-runtime-video",date:"2026-09-01",claim:null,independent_review_state:"NOT_RECORDED",tags:["lane-war","lanewar","battlefield","map","world-layout"],search_text:"lane war lanewar map battlefield",gaps:["independent_review_not_recorded"],media:[{path:"2026-09-01/p3-pr723-v2-lanewar-runtime-video/runtime-contact-sheet.png",bytes:laneImage.length,declared_sha256:digest(laneImage),declared_size_matches:true},{path:"2026-09-01/p3-pr723-v2-lanewar-runtime-video/runtime.mp4",bytes:laneVideo.length,declared_sha256:digest(laneVideo),declared_size_matches:true}]}
]}));

const assetId="60c984e41bf738be97454ef74520e0c0b534c8ebb4f3b84fcb83aa44204b4d4e";
const assetDir=join(t3d,assetId);
await mkdir(join(t3d,".tiny3d","library"),{recursive:true});
await mkdir(join(assetDir,"evidence","showcase"),{recursive:true});
await mkdir(join(assetDir,"receipts"),{recursive:true});
const gif=Buffer.from("android-showcase-gif");
const androidVideo=Buffer.from("android-showcase-video");
await writeFile(join(assetDir,"evidence","showcase","android.gif"),gif);
await writeFile(join(assetDir,"evidence","showcase","android_walk.mp4"),androidVideo);
await writeFile(join(assetDir,"receipts","showcase_evidence.json"),JSON.stringify({schema:"tiny3d.showcase-evidence.v1",accepted:true,proof_scope:"hash-bound showcase motion only",claims:{p3_runtime:"NOT_PROVEN"},media:[{path:"evidence/showcase/android.gif",bytes:gif.length,sha256:digest(gif)},{path:"evidence/showcase/android_walk.mp4",bytes:androidVideo.length,sha256:digest(androidVideo)}]}));
await writeFile(join(t3d,".tiny3d","library","index-v1.json"),JSON.stringify({schema:"tinylab.asset-library-cache.v1",entries:{[assetId]:{record:{asset_id:assetId,display_name:"character_angular_android_blade_herald.glb",source:{name:"android blade herald"},proof:{strongest_state:"TINY3D_VERIFIED",states:{P3_RUNTIME_PROVEN:false},reviewed_visual_proof:[],metadata_gaps:[]},preview:{thumbnail:{status:"available",path:"preview/thumbnail.png",sha256:"0".repeat(64)}}}}}}));

const spell=await resolveVisualProof("spell",{source:"p3",p3Root:p3});
assert.equal(spell.metadata.identity,"p3-pr750-meteor-vfx-accepted");
assert.equal(spell.metadata.independent_review_state,"PROVEN");
assert.deepEqual(spell.image,meteor);
const map=await resolveVisualProof("map",{source:"p3",p3Root:p3});
assert.equal(map.metadata.identity,"p3-pr723-v2-lanewar-runtime-video","semantic map tag must outrank incidental /Maps/ text");
assert.equal(map.metadata.independent_review_state,"NOT_RECORDED");
assert.deepEqual(map.image,laneImage);
assert.deepEqual(map.video,laneVideo);

const android=await resolveVisualProof("android",{source:"tiny3d",tiny3dRoot:t3d});
assert.equal(android.metadata.identity,assetId);
assert.equal(android.metadata.evidence_type,"showcase");
assert.equal(android.metadata.strongest_state,"TINY3D_VERIFIED");
assert.equal(android.metadata.is_runtime_proof,false);
assert.equal(android.metadata.independent_review_state,"NOT_RECORDED");
assert.deepEqual(android.image,gif);
assert.deepEqual(android.video,androidVideo);

const result=await visualProofToolResult("lane war",{source:"p3",p3Root:p3});
const imageBlock=result.content.find((x)=>x.type==="image");
const videoBlock=result.content.find((x)=>x.type==="resource");
assert.deepEqual(Buffer.from(imageBlock.data,"base64"),laneImage,"model image content must be exact stored bytes");
assert.equal(result.structuredContent.image.sha256,digest(laneImage));
assert.deepEqual(Buffer.from(videoBlock.resource.blob,"base64"),laneVideo,"widget video resource must be exact stored bytes");
assert.equal(result.structuredContent.video.sha256,digest(laneVideo));
assert.equal(result._meta["openai/outputTemplate"],VISUAL_PROOF_WIDGET_URI);
assert.equal(result._meta.ui.resourceUri,VISUAL_PROOF_WIDGET_URI);

const html=visualProofWidgetHtml();
assert.match(html,/ui\/notifications\/tool-result/);
assert.match(html,/data:'\+image\.mimeType\+';base64/);
assert.match(html,/<video/);
assert.doesNotMatch(html,/fetch\(|https?:\/\//,"widget must render the tool result without a second media transport");

const exactRejected = await resolveVisualProof("p3-pr622-meteor-rejected", {source:"p3",p3Root:p3});
assert.equal(exactRejected.metadata.independent_review_state,"REJECTED");
assert.deepEqual(exactRejected.image,rejected,"exact run lookup must reopen rejected diagnostic evidence");

const elements = new Map();
const events = new Map();
const posted = [];
const parent = {postMessage:(message)=>posted.push(message)};
const element = (id) => {
  if (!elements.has(id)) elements.set(id, {src:"",textContent:"",classList:{add(){},remove(){}},removeAttribute(key){delete this[key];},pause(){},load(){}});
  return elements.get(id);
};
const window = {parent,openai:{toolResponseMetadata:{mcp_tool_result:result}},addEventListener:(name,handler)=>events.set(name,handler)};
runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{window,document:{getElementById:element}});
assert.equal(element("image").src,`data:${imageBlock.mimeType};base64,${imageBlock.data}`,"ChatGPT envelope must deliver exact model image to widget");
assert.equal(posted[0].method,"ui/initialize");
events.get("message")({source:parent,data:{jsonrpc:"2.0",id:"visual-proof-init",result:{protocolVersion:"2026-01-26"}}});
assert.equal(posted[1].method,"ui/notifications/initialized");
events.get("message")({source:parent,data:{jsonrpc:"2.0",method:"ui/notifications/tool-result",params:{structuredContent:{identity:"next-run",independent_review_state:"REJECTED"},content:[]}}});
assert.ok(!element("image").src,"missing next image must not leave previous proof on screen");
assert.ok(!element("video").src,"missing next video must not leave previous proof on screen");
assert.equal(element("review").textContent,"REJECTED");
events.get("message")({source:{},data:{jsonrpc:"2.0",method:"ui/notifications/tool-result",params:result}});
assert.ok(!element("image").src,"unrelated window messages cannot replace evidence");

process.env.P3_VISUAL_EVIDENCE_ROOT=p3;
const server=new McpServer({name:"proof-canary",version:"1"});
registerVisualProofApp(server);
const client=new Client({name:"proof-review",version:"1"});
const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  const tools=await client.listTools();
  assert.equal(tools.tools[0]._meta.ui.resourceUri,VISUAL_PROOF_WIDGET_URI);
  const resource=await client.readResource({uri:VISUAL_PROOF_WIDGET_URI});
  assert.equal(resource.contents[0].mimeType,"text/html;profile=mcp-app");
  const opened=await client.callTool({name:"open_visual_proof",arguments:{query:"p3-pr622-meteor-rejected",source:"p3"}});
  assert.equal(opened.structuredContent.independent_review_state,"REJECTED");
  assert.deepEqual(Buffer.from(opened.content.find(x=>x.type==="image").data,"base64"),rejected);
} finally {await client.close();await server.close();}

assert.equal(spell.metadata.is_runtime_proof,null,"visual acceptance alone does not establish runtime scope");
assert.equal(spell.metadata.strongest_state,null);
const auto=await resolveVisualProof("p3-pr622-meteor-rejected",{source:"auto",p3Root:p3,tiny3dRoot:join(t3d,"absent")});
assert.equal(auto.metadata.identity,"p3-pr622-meteor-rejected","missing optional source must not hide available evidence");
const storedIndex=await readFile(join(p3,"index-v1.json"),"utf8");
const altered=JSON.parse(storedIndex);
delete altered.entries[1].media[0].declared_sha256;
await writeFile(join(p3,"index-v1.json"),JSON.stringify(altered));
await assert.rejects(()=>resolveVisualProof("p3-pr622-meteor-rejected",{source:"p3",p3Root:p3}),/no valid stored SHA-256/);
const outside=await mkdtemp(join(tmpdir(),"proof-app-outside-"));
await writeFile(join(outside,"outside.png"),rejected);
await symlink(outside,join(p3,"linked"),process.platform==="win32"?"junction":"dir");
altered.entries[1].media[0]={path:"linked/outside.png",bytes:rejected.length,declared_sha256:digest(rejected)};
await writeFile(join(p3,"index-v1.json"),JSON.stringify(altered));
await assert.rejects(()=>resolveVisualProof("p3-pr622-meteor-rejected",{source:"p3",p3Root:p3}),/real path escapes/);
await writeFile(join(p3,"index-v1.json"),storedIndex);

await writeFile(join(laneDir,"runtime-contact-sheet.png"),Buffer.concat([laneImage,Buffer.from("tamper")]));
await assert.rejects(()=>resolveVisualProof("lane war",{source:"p3",p3Root:p3}),/size changed|SHA-256 changed/);

console.log("visual proof app tests passed");
