import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bindMcpSessionToCurrentActor, getMcpActorId } from "./mcp-request-context.js";

const SESSION_TTL_MS = Number(process.env.MCP_SESSION_TTL_MS || 600000);
const INIT_TTL_MS = Number(process.env.MCP_UNATTACHED_INIT_TTL_MS || 60000);
const DELETE_GRACE_MS = Number(process.env.MCP_SESSION_DELETE_GRACE_MS || 45000);
const MAX_SESSIONS = Number(process.env.MCP_MAX_SESSIONS || 64);
const CLEANUP_MS = Number(process.env.MCP_SESSION_CLEANUP_MS || 30000);

type Session = { transport: StreamableHTTPServerTransport; server: McpServer; last: number; created: number; used: boolean };
export type ServerFactory = () => McpServer;

function requestId(body: unknown): string|number|null {
  if (!body || typeof body !== "object" || !("id" in body)) return null;
  const id = (body as {id?:unknown}).id; return typeof id === "string" || typeof id === "number" ? id : null;
}
function protocol(v?: string) { return v && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(v) ? v : LATEST_PROTOCOL_VERSION; }
function patchHeaders(req: Request, sid: string, version: string): Request {
  const headers = { ...req.headers, "mcp-session-id": sid, "mcp-protocol-version": version };
  const raw: string[] = [], drop = new Set(["mcp-session-id","mcp-protocol-version"]);
  for (let i=0;i<(req.rawHeaders||[]).length;i+=2) if (!drop.has(req.rawHeaders[i]?.toLowerCase())) raw.push(req.rawHeaders[i],req.rawHeaders[i+1]);
  raw.push("mcp-session-id",sid,"mcp-protocol-version",version);
  return Object.assign(req,{headers,rawHeaders:raw});
}
export { isInitializeRequest, requestId as extractRequestId };

export function createSessionManager(factory: ServerFactory, port: number, internalToken: string) {
  const sessions = new Map<string,Session>();
  const pending = new Map<string,Session>();
  const chains = new Map<string,Promise<void>>();
  const deleteTimers = new Map<string,ReturnType<typeof setTimeout>>();
  let cleanup: ReturnType<typeof setInterval>|undefined;

  const queue = async (sid:string, fn:()=>Promise<void>) => { const prev=chains.get(sid)||Promise.resolve(); const run=prev.catch(()=>{}).then(fn); chains.set(sid,run); try{await run}finally{if(chains.get(sid)===run) chains.delete(sid)} };
  const cancelDelete=(sid:string)=>{const t=deleteTimers.get(sid); if(t){clearTimeout(t);deleteTimers.delete(sid)}};
  const remove=async(sid:string)=>{cancelDelete(sid); const s=sessions.get(sid); if(!s)return; sessions.delete(sid); chains.delete(sid); await s.transport.close().catch(()=>{}); await s.server.close().catch(()=>{});};
  const touch=(sid:string)=>{cancelDelete(sid); const s=sessions.get(sid); if(s)s.last=Date.now()};
  const evict=()=>{ const candidates=[...sessions.entries()].filter(([,s])=>!s.used).sort((a,b)=>a[1].created-b[1].created); while(sessions.size>MAX_SESSIONS&&candidates.length) void remove(candidates.shift()![0]); };

  async function build(preferred?:string):Promise<Session>{
    const server=factory();
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:preferred?()=>preferred:()=>randomUUID(),enableJsonResponse:true,
      onsessioninitialized:(sid)=>{const old=sessions.get(sid);sessions.set(sid,{transport,server,last:Date.now(),created:old?.created||Date.now(),used:old?.used||false});pending.delete(sid);evict();},
      onsessionclosed:(sid)=>{if(!sid)return;cancelDelete(sid);const t=setTimeout(()=>void remove(sid),DELETE_GRACE_MS);t.unref?.();deleteTimers.set(sid,t);}
    });
    transport.onclose=()=>{};
    await server.connect(transport);
    return sessions.get(transport.sessionId||preferred||"") || {transport,server,last:Date.now(),created:Date.now(),used:false};
  }
  async function loopback(path:string,body:unknown,sid?:string,version?:string){
    const h:Record<string,string>={"Content-Type":"application/json",Accept:"application/json, text/event-stream","x-mcp-internal-recovery":"1",Authorization:`Bearer ${internalToken}`};
    if(sid)h["mcp-session-id"]=sid;if(version)h["mcp-protocol-version"]=version;
    const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:"POST",headers:h,body:JSON.stringify(body)});return r.ok;
  }
  async function recover(stale:string,req:Request,res:Response,body:unknown){
    if(isInitializeRequest(body))return false;
    const v=protocol(req.headers["mcp-protocol-version"] as string|undefined), path=req.path||"/mcp";
    pending.set(stale,await build(stale));
    const init=await loopback(path,{jsonrpc:"2.0",id:"__recover__",method:"initialize",params:{protocolVersion:v,capabilities:{},clientInfo:{name:"mcp-recovery",version:"1"}}},stale);
    const note=init&&await loopback(path,{jsonrpc:"2.0",method:"notifications/initialized"},stale,v);
    if(!note||!sessions.has(stale)){pending.delete(stale);await remove(stale);return false}
    const s=sessions.get(stale)!;s.used=true;touch(stale);await queue(stale,()=>s.transport.handleRequest(patchHeaders(req,stale,v),res,body));return true;
  }

  return {
    get:(sid:string)=>sessions.get(sid), count:()=>sessions.size,
    async create(req:Request,res:Response,body:unknown){const actor=getMcpActorId(); const header=req.headers["mcp-session-id"] as string|undefined; const s=header&&pending.get(header)||await build(); if(header)pending.delete(header); const fn=async()=>{await s.transport.handleRequest(req,res,body); const sid=s.transport.sessionId;if(sid){touch(sid);if(req.headers["x-mcp-internal-recovery"]!=="1")await bindMcpSessionToCurrentActor(sid,actor)}}; const sid=header||s.transport.sessionId; sid?await queue(sid,fn):await fn();},
    async stateless(req:Request,res:Response,body:unknown){const s=await build();try{await s.transport.handleRequest(req,res,body)}finally{await s.transport.close().catch(()=>{});await s.server.close().catch(()=>{})}},
    async existing(s:Session,req:Request,res:Response,body?:unknown){const sid=s.transport.sessionId||(req.headers["mcp-session-id"] as string|undefined); const method=body&&typeof body==="object"&&"method" in body?String((body as any).method||""):"";if(sid&&(req.method==="GET"||method!=="notifications/initialized")){s.used=true;touch(sid)};const fn=async()=>{await s.transport.handleRequest(req,res,body);if(method==="notifications/initialized"&&req.headers["x-mcp-internal-recovery"]!=="1")s.server.sendToolListChanged()}; sid&&req.method!=="GET"?await queue(sid,fn):await fn();},
    recover,
    notFound(res:Response,id:string|number|null=null){res.status(404).json({jsonrpc:"2.0",error:{code:-32001,message:"Session not found"},id})},
    bad(res:Response,msg:string,id:string|number|null=null){res.status(400).json({jsonrpc:"2.0",error:{code:-32000,message:msg},id})},
    start(){cleanup=setInterval(()=>{const now=Date.now();for(const[sid,s]of sessions){if((!s.used&&now-s.created>INIT_TTL_MS)||(s.used&&now-s.last>SESSION_TTL_MS))void remove(sid)}evict()},CLEANUP_MS);cleanup.unref?.()},
    stop(){if(cleanup)clearInterval(cleanup)}
  };
}
