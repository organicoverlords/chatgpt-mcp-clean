import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runWithMcpHandlerContext } from "./lib/mcp-request-context.js";
import { registerFileTools } from "./tools/files.js";
import { registerShellTools } from "./tools/shell.js";
import { registerGitTools } from "./tools/git.js";
import { registerGithubTools } from "./tools/github.js";

export function createServer(defaultCwd:string):McpServer{
  const server=new McpServer({name:"chatgpt-mcp-clean",version:"0.1.0"});
  const original=server.registerTool.bind(server);
  server.registerTool=((name:any,config:any,callback:any)=>original(name,config,((...args:any[])=>{
    const extra=args.at(-1); return runWithMcpHandlerContext(extra,()=>callback(...args));
  }) as any)) as typeof server.registerTool;
  registerFileTools(server); registerShellTools(server,defaultCwd); registerGitTools(server); registerGithubTools(server);
  return server;
}
