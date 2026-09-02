import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); const dir=mkdtempSync(join(tmpdir(),"mcp-no-hot-health-"));
let health=0,primaryCalls=0,fallbackCalls=0,primary,fallback,front;
const listen=async(s)=>{await new Promise(r=>s.listen(0,"127.0.0.1",r));return s.address().port;};
const unused=async()=>{const s=createServer();const p=await listen(s);await new Promise(r=>s.close(r));return p;};
const json=(r,v)=>{r.setHeader("content-type","application/json");r.end(JSON.stringify(v));};
try {
 primary=createServer((q,r)=>{if(q.url==="/health"){health++;setTimeout(()=>json(r,{status:"ok",name:"shell-mcp",port:primary.address().port}),1500);return;} if(q.url==="/mcp"){primaryCalls++;json(r,{jsonrpc:"2.0",id:1,result:{content:[{type:"text",text:"PRIMARY"}]}});return;} r.statusCode=404;r.end();});
 fallback=createServer((q,r)=>{if(q.url==="/health"){json(r,{status:"ok",name:"shell-mcp",port:fallback.address().port});return;} if(q.url==="/mcp"){fallbackCalls++;json(r,{jsonrpc:"2.0",id:1,result:{content:[{type:"text",text:"FALLBACK"}]}});return;} r.statusCode=404;r.end();});
 const a=await listen(primary),b=await listen(fallback),fp=await unused();
 const active=join(dir,"active.json"),routes=join(dir,"routes.json"),statics=join(dir,"statics.json"),log=join(dir,"log.jsonl");
 writeFileSync(active,JSON.stringify({version:1,port:a,generation:"primary"}));writeFileSync(routes,JSON.stringify({version:1,routes:{}}));writeFileSync(statics,JSON.stringify({version:1,routes:{"clone-a":[a,b]}}));
 front=spawn(process.execPath,[resolve("dist/front-door.js")],{env:{...process.env,FRONT_DOOR_PORT:String(fp),MCP_BACKEND_CONFIG_PATH:active,MCP_PROCESS_ROUTE_PATH:routes,FRONT_DOOR_STATIC_ROUTE_PATH:statics,FRONT_DOOR_REQUEST_LOG_PATH:log},stdio:["ignore","pipe","pipe"],windowsHide:true});
 const origin=`http://127.0.0.1:${fp}`; for(let i=0;i<100;i++){try{if((await fetch(`${origin}/health`)).ok)break;}catch{} await sleep(25);if(i===99)throw new Error("front door health timeout");}
 const t=Date.now(); const r=await fetch(`${origin}/clone-a/mcp`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"start_process",arguments:{command:"x"}}})}); const body=await r.json();
 assert.equal(r.status,200);assert.equal(body.result.content[0].text,"PRIMARY");assert.equal(primaryCalls,1);assert.equal(health,0);assert.equal(fallbackCalls,0);assert.ok(Date.now()-t<1000);
 console.log("PASS front_door_no_hotpath_health primary_health_calls=0 fallback_mcp_calls=0");
} finally {if(front&&front.exitCode===null)front.kill();if(primary)await new Promise(r=>primary.close(r));if(fallback)await new Promise(r=>fallback.close(r));rmSync(dir,{recursive:true,force:true});}
