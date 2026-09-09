import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerVisualProofApp } from "./visual-proof-app.js";
import { registerVisualProofReviewTools } from "./visual-proof-review.js";

export function registerOptionalVisualProofTools(server: McpServer, requestCallerId: string): void {
  const toolProfile = (process.env.MCP_TOOL_PROFILE || "process").trim().toLowerCase();
  if (toolProfile !== "full" || process.env.MCP_VISUAL_PROOF_UI !== "1") return;
  registerVisualProofApp(server);
  if (process.env.MCP_VISUAL_PROOF_REVIEW === "1") registerVisualProofReviewTools(server, requestCallerId);
}
