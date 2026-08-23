import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runWithMcpHandlerContext } from "./lib/mcp-request-context.js";
import { auditToolCall } from "./lib/audit.js";
import { registerFileTools } from "./tools/files.js";
import { registerShellTools } from "./tools/shell.js";
import { registerGitTools } from "./tools/git.js";
import { registerGithubTools } from "./tools/github.js";
import { registerWorkflowSkills } from "./tools/workflow-skills.js";
import { registerAuditTools } from "./tools/audit-log.js";

export function createServer(defaultCwd:string):McpServer{
  const server=new McpServer({name:"chatgpt-mcp-clean",version:"0.1.0"});
  const enabledTools=new Set(["actor_status","busy_list","busy_claim","busy_release","run_command"]);
  const original=server.registerTool.bind(server);
  server.registerTool=((name:any,config:any,callback:any)=>{
    if(!enabledTools.has(String(name)))return undefined as any;
    return original(name,config,((...args:any[])=>{
      const extra=args.at(-1); return runWithMcpHandlerContext(extra,async()=>{
        const started=Date.now();
        try {
          const result=await callback(...args);
          const status=result?.structuredContent?.ok===false?"blocked":"ok";
          await auditToolCall(String(name),status,Date.now()-started,args[0]);
          return result;
        } catch(error) {
          await auditToolCall(String(name),"error",Date.now()-started,args[0],error instanceof Error?error.message:String(error));
          throw error;
        }
      });
    }) as any);
  }) as typeof server.registerTool;
  registerFileTools(server); registerShellTools(server,defaultCwd); registerGitTools(server); registerGithubTools(server); registerWorkflowSkills(server); registerAuditTools(server);
  return server;
}
