import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readToolAudit } from "../lib/audit.js";

const out=(tool:string,data:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(data)}],structuredContent:{ok:true,tool,data}});
export function registerAuditTools(server:McpServer){
  server.registerTool("audit_tail",{description:"Return recent sanitized MCP tool-call audit rows.",inputSchema:{limit:z.number().int().min(1).max(500).optional()}},async({limit=100})=>out("audit_tail",{calls:await readToolAudit(limit)}));
}
