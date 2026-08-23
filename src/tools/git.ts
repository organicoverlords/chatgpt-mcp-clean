import { spawn } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "../lib/audit.js";
import { safeChildEnv } from "../lib/safe-env.js";

const out=(tool:string,data:unknown,ok=true)=>({content:[{type:"text" as const,text:JSON.stringify(data)}],structuredContent:{ok,tool,data}});
function git(cwd:string,args:string[]){return new Promise<{stdout:string,stderr:string,exit_code:number|null}>((resolve,reject)=>{const p=spawn("git",args,{cwd,windowsHide:true,env:safeChildEnv()});let stdout="",stderr="";p.stdout.on("data",d=>stdout+=d);p.stderr.on("data",d=>stderr+=d);p.on("error",reject);p.on("close",code=>resolve({stdout:stdout.trim(),stderr:stderr.trim(),exit_code:code}))})}
export function registerGitTools(server:McpServer){
 const tool=(name:string,description:string,args:z.ZodRawShape,make:(i:any)=>string[])=>server.registerTool(name,{description,inputSchema:{path:z.string(),...args}},async(input:any)=>{const r=await git(input.path,make(input));await audit(name,r.exit_code===0?"ok":"error",{path:input.path,exit_code:r.exit_code});return out(name,{...r,path:input.path},r.exit_code===0)});
 tool("git_status","Show git status.",{},()=>["status","--short","--branch"]);
 tool("git_diff","Show git diff.",{staged:z.boolean().optional(),file:z.string().optional()},i=>["diff",...(i.staged?["--cached"]:[]),...(i.file?["--",i.file]:[])]);
 tool("git_log","Show recent commits.",{count:z.number().int().min(1).max(100).optional()},i=>["log",`-${i.count||10}`,"--oneline","--decorate"]);
 tool("git_add","Stage files.",{files:z.array(z.string()).min(1)},i=>["add","--",...i.files]);
 tool("git_commit","Commit staged changes.",{message:z.string().min(1)},i=>["commit","-m",i.message]);
 tool("git_push","Push branch.",{remote:z.string().optional(),branch:z.string().optional(),set_upstream:z.boolean().optional()},i=>["push",...(i.set_upstream?["-u"]:[]),i.remote||"origin",...(i.branch?[i.branch]:[])]);
 tool("git_pull","Pull branch.",{remote:z.string().optional(),branch:z.string().optional()},i=>["pull",i.remote||"origin",...(i.branch?[i.branch]:[])]);
 tool("git_checkout","Switch branch.",{branch:z.string()},i=>["checkout",i.branch]);
}
