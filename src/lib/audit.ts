import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getMcpActorId } from "./mcp-request-context.js";

const file = () => process.env.AUDIT_LOG_PATH || path.resolve(process.cwd(), ".state", "audit.jsonl");
export async function audit(tool: string, status: "ok"|"error"|"blocked", details: Record<string, unknown> = {}) {
  const row = { time: new Date().toISOString(), pid: process.pid, ...(getMcpActorId() ? { actor_id: getMcpActorId() } : {}), tool, status, details };
  try { await mkdir(path.dirname(file()), { recursive: true }); await appendFile(file(), JSON.stringify(row)+"\n", "utf8"); } catch {}
}
