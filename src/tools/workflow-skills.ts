import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const root = () => path.resolve(process.cwd(), "workflows");
const out = (tool: string, data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: { ok: true, tool, data } });
const read = (...parts: string[]) => fs.readFile(path.join(root(), ...parts), "utf8");

export function registerWorkflowSkills(server: McpServer) {
  server.registerTool("orchestration_skill", { description: "Return the orchestration workflow. Read-only; does not inspect state or mutate anything.", inputSchema: {} }, async () =>
    out("orchestration_skill", { name: "orchestration", content: await read("orchestration", "SKILL.md") })
  );

  server.registerTool("incident_report_skill", { description: "Return the incident-report workflow and verification contract. Read-only; does not create an incident.", inputSchema: {} }, async () =>
    out("incident_report_skill", {
      name: "incident-report",
      content: await read("incident-report", "SKILL.md"),
      references: [{ name: "incident-contract.md", content: await read("incident-report", "incident-contract.md") }],
      verifier: { name: "verify_incident_capture.py", content: await read("incident-report", "verify_incident_capture.py") }
    })
  );
}
