import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { BoundedJsonlWriter } from "./bounded-jsonl.js";
import { currentTelemetryContext } from "./transport-telemetry.js";

// Diagnostics only. Never change a request, spawn a process, or read OAuth state.
const writer = new BoundedJsonlWriter(resolve(process.env.MCP_PROCESS_AUDIT_PATH ||
  join(dirname(resolve(process.env.MCP_TRANSPORT_LOG_PATH || ".state/transport.jsonl")), "process-calls.jsonl")), {
  onError: error => console.error("process audit write failed:", error.message),
});
const LIMIT = 4_000;
function textEvidence(value: string): Record<string, unknown> {
  const redacted = value.replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/((?:access_token|refresh_token|client_secret|password|authorization)\s*[=:]\s*)(["']?)[^\s,;\r\n]+/gi, "$1[redacted]");
  return { text: redacted.slice(0, LIMIT), chars: value.length,
    truncated: redacted.length > LIMIT,
    sha256: createHash("sha256").update(value).digest("hex") };
}
export function auditProcessRequest(tool: string, input: unknown): void {
  const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const executable = typeof args.executable === "string" ? args.executable : undefined;
  const argv = Array.isArray(args.args) ? args.args.filter((v): v is string => typeof v === "string") : [];
  const script = typeof args.script === "string" ? args.script : undefined;
  const command = script !== undefined ? `[${String(args.language)} script]\n${script}` :
    executable !== undefined ? [executable, ...argv.map(v => JSON.stringify(v))].join(" ") : undefined;
  writer.writeJson({ at: new Date().toISOString(), server_pid: process.pid, ...currentTelemetryContext(),
    event: "process_call_requested", tool, argument_keys: Object.keys(args),
    ...(command !== undefined ? { command: textEvidence(command) } : {}),
    ...(typeof args.process_id === "string" ? { process_id: args.process_id } : {}),
    ...(typeof args.working_directory === "string" ? { cwd: args.working_directory } : {}),
    input_mode: script !== undefined ? "script" : executable !== undefined ? "executable" : "other",
    stdin_chars: typeof args.stdin === "string" ? args.stdin.length : 0,
    // Arbitrary stdin and environment values can contain credentials. Do not persist them.
    env_keys: args.env && typeof args.env === "object" ? Object.keys(args.env) : [],
  });
}
export function auditProcessResponse(tool: string, reply: unknown, context = currentTelemetryContext()): void {
  if (!reply || typeof reply !== "object") return;
  const envelope = reply as Record<string, any>;
  const result = envelope.result;
  const output = result?.structuredContent;
  const isError = Boolean(envelope.error || result?.isError);
  const errorText = envelope.error?.message || (isError && Array.isArray(result?.content)
    ? result.content.filter((v: any) => v.type === "text").map((v: any) => v.text).join("\n") : undefined);
  writer.writeJson({ at: new Date().toISOString(), server_pid: process.pid, ...context,
    event: "process_call_returned", tool, jsonrpc_id: envelope.id ?? null,
    is_error: isError, error_code: envelope.error?.code ?? null,
    ...(typeof errorText === "string" ? { error: textEvidence(errorText) } : {}),
    ...(output && typeof output === "object" ? {
      process_id: output.process_id ?? null, pid: output.pid ?? null, running: output.running ?? null,
      exit_code: output.exit_code ?? null, next_action: output.next_action ?? null,
      execution_mode: output.execution_mode ?? null, execution_reason: output.execution_reason ?? null,
      stdout_chars: typeof output.stdout === "string" ? output.stdout.length : 0,
      stderr_chars: typeof output.stderr === "string" ? output.stderr.length : 0,
      ...(output.failure_diagnostic ? { failure_diagnostic: output.failure_diagnostic } : {}),
    } : {}),
  });
}
export async function flushProcessAudit(): Promise<void> { await writer.flush(); }
