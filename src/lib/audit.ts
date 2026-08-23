import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getMcpActorId } from "./mcp-request-context.js";

const file = () => process.env.AUDIT_LOG_PATH || path.resolve(process.cwd(), ".state", "audit.jsonl");
const cut = (value: unknown, max = 2000) => String(value ?? "").slice(0, max);
const bytes = (value: unknown) => Buffer.byteLength(String(value ?? ""), "utf8");
const redact = (value: unknown) => cut(value).replace(/((?:token|secret|password|authorization|api[_-]?key)\s*[=:]\s*)[^\s;]+/gi, "$1[REDACTED]");

export function summarizeToolInput(tool: string, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const x = input as Record<string, unknown>, out: Record<string, unknown> = {};
  for (const k of ["path","working_directory","repo","issue","id","pattern","glob","branch","remote","count","limit","max_results","timeout_seconds","staged","set_upstream","replace_all"]) if (x[k] !== undefined) out[k] = x[k];
  if (typeof x.command === "string") out.command = redact(x.command);
  if (typeof x.message === "string") out.message = redact(x.message).slice(0, 500);
  if (typeof x.what === "string") out.what = redact(x.what).slice(0, 300);
  if (Array.isArray(x.files)) out.files = x.files.slice(0, 50).map(v => cut(v, 500));
  if (x.content !== undefined) out.content_bytes = bytes(x.content);
  if (x.old_text !== undefined) out.old_text_bytes = bytes(x.old_text);
  if (x.new_text !== undefined) out.new_text_bytes = bytes(x.new_text);
  if (x.body !== undefined) out.body_bytes = bytes(x.body);
  return out;
}

async function write(row: Record<string, unknown>) {
  try { await mkdir(path.dirname(file()), { recursive: true }); await appendFile(file(), JSON.stringify(row)+"\n", "utf8"); } catch {}
}

export async function audit(tool: string, status: "ok"|"error"|"blocked", details: Record<string, unknown> = {}) {
  await write({ kind: "detail", time: new Date().toISOString(), pid: process.pid, ...(getMcpActorId() ? { actor_id: getMcpActorId() } : {}), tool, status, details });
}

export async function auditToolCall(tool: string, status: "ok"|"error"|"blocked", durationMs: number, input: unknown, error?: unknown) {
  await write({ kind: "tool_call", time: new Date().toISOString(), pid: process.pid, actor_id: getMcpActorId() || "actor-unknown", tool, status, duration_ms: durationMs, input: summarizeToolInput(tool, input), ...(error ? { error: redact(error).slice(0, 1000) } : {}) });
}

export async function readToolAudit(limit = 100) {
  try {
    const text = await readFile(file(), "utf8");
    return text.trim().split(/\r?\n/).reverse().map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(row => row?.kind === "tool_call").slice(0, Math.max(1, Math.min(limit, 500))).reverse();
  } catch { return []; }
}
