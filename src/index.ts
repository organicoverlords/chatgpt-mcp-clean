#!/usr/bin/env node
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { LocalOAuthProvider } from "./lib/local-oauth-provider.js";
import { createServer } from "./server.js";
import { createSessionManager, extractRequestId, isInitializeRequest } from "./lib/session-manager.js";
import { runWithMcpRequestContext, getMcpActorId } from "./lib/mcp-request-context.js";
import { audit } from "./lib/audit.js";

const PORT=Number(process.env.PORT||3000),HOST=process.env.HOST||"127.0.0.1";
const ORIGIN=(process.env.MCP_PUBLIC_ORIGIN||"").trim(),OWNER=(process.env.TAILSCALE_OWNER_LOGIN||"").trim().toLowerCase();
const STORE=path.resolve(process.env.MCP_OAUTH_STORE_PATH||path.join(process.cwd(),".state","oauth.json"));
const DEFAULT_CWD=path.resolve(process.env.MCP_DEFAULT_CWD||process.env.USERPROFILE||process.cwd());
const RECOVERY=(process.env.MCP_SESSION_RECOVERY||"true").toLowerCase()!=="false";
const INTERNAL=crypto.randomBytes(32).toString("base64url");
if(!["127.0.0.1","::1","localhost"].includes(HOST.toLowerCase()))throw new Error("loopback bind required");
if(!ORIGIN||!OWNER)throw new Error("MCP_PUBLIC_ORIGIN and TAILSCALE_OWNER_LOGIN are required");
const publicOrigin=new URL(ORIGIN);if(publicOrigin.protocol!=="https:"||!publicOrigin.hostname.endsWith(".ts.net"))throw new Error("MCP_PUBLIC_ORIGIN must be an HTTPS .ts.net origin");
const resource=new URL("/mcp",publicOrigin),oauth=new LocalOAuthProvider(resource,OWNER,STORE);
const legacy=(process.env.MCP_LEGACY_PATH||"").trim();
const paths=["/mcp",...(/^\/mcp\/[A-Za-z0-9_-]{16,128}$/.test(legacy)?[legacy]:[])];
const pathSet=new Set(paths);

const app=express();app.set("trust proxy","loopback");app.use(express.json({limit:"10mb"}));
app.use("/authorize",(req,res,next)=>{const login=(req.header("tailscale-user-login")||"").trim().toLowerCase();if(login && login!==OWNER){res.status(403).send("Owner authorization required");return}next()});
app.get("/.well-known/openid-configuration",(_req,res)=>res.json({issuer:publicOrigin.href,authorization_endpoint:new URL("/authorize",publicOrigin).href,token_endpoint:new URL("/token",publicOrigin).href,registration_endpoint:new URL("/register",publicOrigin).href,response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],token_endpoint_auth_methods_supported:["none"],code_challenge_methods_supported:["S256"],scopes_supported:["mcp"]}));
app.use(mcpAuthRouter({provider:oauth,issuerUrl:publicOrigin,resourceServerUrl:resource,scopesSupported:["mcp"],resourceName:"Local MCP"}));
const bearer=requireBearerAuth({verifier:oauth,requiredScopes:["mcp"],resourceMetadataUrl:getOAuthProtectedResourceMetadataUrl(resource)});
const auth:express.RequestHandler=(req,res,next)=>{if(req.header("x-mcp-internal-recovery")==="1"){const h=req.headers.authorization;if(h?.startsWith("Bearer ")){const a=Buffer.from(h.slice(7)),b=Buffer.from(INTERNAL);if(a.length===b.length&&crypto.timingSafeEqual(a,b)){res.locals.internal=true;next();return}}}bearer(req,res,next)};
const sessions=createSessionManager(()=>createServer(DEFAULT_CWD),PORT,INTERNAL);sessions.start();

async function post(req:express.Request,res:express.Response){await runWithMcpRequestContext(req,async()=>{const sid=req.headers["mcp-session-id"] as string|undefined,id=extractRequestId(req.body),started=Date.now();try{if(isInitializeRequest(req.body)){await sessions.create(req,res,req.body)}else if(!sid){await sessions.stateless(req,res,req.body)}else{const s=sessions.get(sid);if(s)await sessions.existing(s,req,res,req.body);else if(RECOVERY&&await sessions.recover(sid,req,res,req.body)){}else sessions.notFound(res,id)}}catch(e:any){if(!res.headersSent)res.status(500).json({jsonrpc:"2.0",error:{code:-32603,message:"Internal server error"},id});await audit("__mcp_request__","error",{method:req.body?.method,tool:req.body?.params?.name,duration_ms:Date.now()-started,error:String(e?.message||e)})}finally{if(!res.headersSent){}else await audit("__mcp_request__",res.statusCode>=400?"blocked":"ok",{method:req.body?.method,tool:req.body?.params?.name,duration_ms:Date.now()-started,http_status:res.statusCode,actor_id:getMcpActorId()})}})}
async function getdel(req:express.Request,res:express.Response){const sid=req.headers["mcp-session-id"] as string|undefined;if(!sid){sessions.bad(res,"Mcp-Session-Id required");return}const s=sessions.get(sid);if(!s){sessions.notFound(res);return}await sessions.existing(s,req,res,undefined)}
for(const p of paths){app.post(p,auth,post);app.get(p,auth,getdel);app.delete(p,auth,getdel)}
app.get("/health",(_req,res)=>res.json({status:"ok",name:"chatgpt-mcp-clean",sessions:sessions.count()}));
const http=app.listen(PORT,HOST,()=>console.log(`chatgpt-mcp-clean listening ${HOST}:${PORT}`));
http.keepAliveTimeout=65000;http.keepAliveTimeoutBuffer=5000;http.headersTimeout=75000;
const stop=()=>{sessions.stop();http.close(()=>process.exit(0));setTimeout(()=>process.exit(1),5000).unref()};process.on("SIGINT",stop);process.on("SIGTERM",stop);
