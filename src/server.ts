import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "node:path";
import { isBootstrapSnapshot, readBootstrapSnapshot } from "./lib/bootstrap-snapshot.js";
import { z } from "zod";
import { BusyStore } from "./lib/busy-store.js";
import { viewImage } from "./lib/image-viewer.js";
import { ProcessManager } from "./lib/process-manager.js";
import { registerFileTransferTools } from "./lib/file-transfer.js";
import { registerTemplateCompatibilityResources } from "./lib/template-compat.js";

// The deployed ChatGPT connector surface is the process profile. Keep the broader
// full profile explicit-only for internal/local tests so repo inspection without a
// deployment-specific environment cannot silently advertise non-plugin tools.
const toolProfile = (process.env.MCP_TOOL_PROFILE || "process").trim().toLowerCase();
if (toolProfile !== "full" && toolProfile !== "process") throw new Error("MCP_TOOL_PROFILE must be full or process");
const fullToolProfile = toolProfile === "full";
const configuredMaxLiveProcessesRaw = process.env.MCP_MAX_LIVE_PROCESSES?.trim();
const configuredMaxLiveProcesses = configuredMaxLiveProcessesRaw ? Number(configuredMaxLiveProcessesRaw) : undefined;
const processManager = new ProcessManager({
  receiptDirectory: resolve(process.env.MCP_PROCESS_RECEIPT_DIR || ".state/process-receipts"),
  ...(configuredMaxLiveProcesses !== undefined ? { maxLiveTotal: configuredMaxLiveProcesses } : {}),
});
const activityToken = /^[A-Za-z0-9._/:_-]+$/;
const activityTargetSchema = z.object({
  type: z.enum(["card", "node", "project"]),
  id: z.string().min(1).max(160).regex(activityToken),
  project: z.string().min(1).max(80).regex(activityToken).optional(),
}).strict();
const actionClassSchema = z.string().min(1).max(64).regex(activityToken);

const processEnvironmentSchema = z.record(
  z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().max(65_536),
).refine((value) => Object.keys(value).length <= 128, "env may contain at most 128 entries")
  .refine((value) => Object.entries(value).reduce((sum, [key, item]) => sum + key.length + item.length, 0) <= 1_000_000, "env payload exceeds 1000000 characters");

const startProcessCommonShape = {
  working_directory: z.string().optional(),
  wait_ms: z.number().int().min(0).max(10_000).optional(),
  activity_target: activityTargetSchema.optional(),
  action_class: actionClassSchema.optional(),
};
const legacyStartProcessCommandVisible = (process.env.MCP_START_PROCESS_LEGACY_COMMAND_VISIBLE || "1").trim() !== "0";
const startProcessInputSchema = z.object({
  executable: z.string().min(1).describe("Program name or absolute executable path; paired with args and optional stdin; no shell re-parsing.").optional(),
  args: z.array(z.string()).max(512).describe("Argument vector passed directly to executable without shell re-parsing.").optional(),
  stdin: z.string().max(1_000_000).describe("Optional standard input passed directly to executable.").optional(),
  env: processEnvironmentSchema.describe("Child-process environment overrides for executable or script input.").optional(),
  script: z.string().min(1).max(1_000_000).describe("Multiline source text for the selected runtime; transported through stdin.").optional(),
  language: z.enum(["powershell", "python", "node", "bash"]).describe("Runtime for script.").optional(),
  ...(legacyStartProcessCommandVisible ? {
    command: z.string().min(1).describe("Legacy shell-command compatibility for shell composition.").optional(),
  } : {}),
  ...startProcessCommonShape,
}).strict().superRefine((value, ctx) => {
  const input = value as typeof value & { command?: string };
  const legacy = input.command !== undefined;
  const structured = input.executable !== undefined;
  const scripted = input.script !== undefined;
  if (Number(legacy) + Number(structured) + Number(scripted) !== 1) ctx.addIssue({ code: "custom", message: legacyStartProcessCommandVisible ? "provide exactly one of command, executable, or script" : "provide exactly one of executable or script" });
  if (!structured && input.args !== undefined) ctx.addIssue({ code: "custom", path: ["args"], message: "args is only valid with executable" });
  if (!structured && input.stdin !== undefined) ctx.addIssue({ code: "custom", path: ["stdin"], message: "stdin is only valid with executable" });
  if (legacy && input.env !== undefined) ctx.addIssue({ code: "custom", path: ["env"], message: "env is only valid with executable or script" });
  if (scripted !== (input.language !== undefined)) ctx.addIssue({ code: "custom", path: ["language"], message: "language is required exactly when script is provided" });
});

const repairAttemptSchema = z.object({
  reason: z.string(),
  command: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().int(),
  started_at: z.string(),
  finished_at: z.string(),
}).strict();

const failureDiagnosticSchema = z.object({
  kind: z.enum(["parser_error", "cli_usage", "spawn_error"]),
  origin: z.enum(["powershell", "python", "node", "bash", "busy_cli", "stack_atlas_cli", "swarm_route_cli", "process"]),
  boundary: z.enum(["source", "legacy_command", "argv_contract", "spawn"]),
  code: z.string().max(80).regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/).optional(),
  input_target: z.object({
    mode: z.enum(["script", "executable"]),
    language: z.enum(["powershell", "python", "node", "bash"]).optional(),
  }).strict().optional(),
}).strict();

const outputPageSchema = z.object({
  stdout_start: z.number().int().nonnegative(),
  stdout_end: z.number().int().nonnegative(),
  stdout_total: z.number().int().nonnegative(),
  stderr_start: z.number().int().nonnegative(),
  stderr_end: z.number().int().nonnegative(),
  stderr_total: z.number().int().nonnegative(),
  page_chars: z.number().int().nonnegative(),
  page_limit: z.number().int().positive(),
  more: z.boolean(),
}).strict();

const snapshotFreshnessSchema = z.object({
  status: z.enum(["FRESH", "STALE"]),
  as_of: z.string(),
  age_seconds: z.number().nonnegative(),
  stale_after_seconds: z.number().nonnegative(),
  read_mode: z.literal("MATERIALIZED_ONLY"),
}).strict();

// start_process may return either its immediate launch receipt or the same completed/read
// shape as read_output. read_output also serves the bounded bootstrap/timeline snapshots.
// Keep one strict object schema for that shared result family so future top-level fields
// cannot silently bypass MCP structured-output validation.
const processOutputSchema = z.object({
  caller_id: z.string(),
  mcp_status: z.enum(["OK", "STALE"]),
  process_state: z.enum(["RUNNING", "COMPLETED", "SNAPSHOT"]),
  elapsed_ms: z.number().nonnegative(),
  next_action: z.enum(["READ_SAME_PROCESS_ID", "STOP_READING"]),
  process_id: z.string(),
  pid: z.number().int().nonnegative().optional(),
  cwd: z.string().optional(),
  running: z.boolean(),
  launching: z.literal(true).optional(),
  activity_target: activityTargetSchema.optional(),
  action_class: actionClassSchema.optional(),
  execution_mode: z.enum(["powershell", "native", "explicit_shell", "native_sequence", "native_pipeline"]).optional(),
  execution_reason: z.string().optional(),
  repair_attempts: z.array(repairAttemptSchema).optional(),
  command: z.string().optional(),
  command_truncated: z.literal(true).optional(),
  submitted_command: z.string().optional(),
  submitted_command_truncated: z.literal(true).optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  no_change: z.literal(true).optional(),
  exit_code: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
  started_at: z.string().optional(),
  finished_at: z.string().nullable().optional(),
  error: z.string().optional(),
  error_code: z.string().max(80).regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/).optional(),
  stdout_truncated: z.literal(true).optional(),
  stderr_truncated: z.literal(true).optional(),
  stdout_dropped_from_start: z.number().int().nonnegative().optional(),
  stderr_dropped_from_start: z.number().int().nonnegative().optional(),
  request_id: z.string().optional(),
  audit_schema: z.literal("process-output-evidence.v1").optional(),
  retained_stdout_chars: z.number().int().nonnegative().optional(),
  retained_stderr_chars: z.number().int().nonnegative().optional(),
  retained_output_chars: z.number().int().nonnegative().optional(),
  retained_stdout_bytes: z.number().int().nonnegative().optional(),
  retained_stderr_bytes: z.number().int().nonnegative().optional(),
  retained_output_bytes: z.number().int().nonnegative().optional(),
  stdout_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  stderr_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  evidence_completeness: z.enum(["complete", "bounded"]).optional(),
  execution_outcome: z.enum(["success", "nonzero_exit", "signaled", "error", "unknown"]).optional(),
  failure_diagnostic: failureDiagnosticSchema.optional(),
  output_page: outputPageSchema.optional(),
  generated_at: z.string().optional(),
  freshness: snapshotFreshnessSchema.optional(),
  snapshot_alias: z.literal(true).optional(),
  bootstrap_alias: z.literal(true).optional(),
}).strict();

const killProcessOutputSchema = z.object({
  caller_id: z.string(),
  process_id: z.string(),
  pid: z.number().int().nonnegative(),
  killed: z.boolean(),
  already_exited: z.literal(true).optional(),
  exit_code: z.number().int().nullable().optional(),
  kill_requested: z.literal(true).optional(),
  running: z.boolean().optional(),
  kill_timed_out: z.literal(true).optional(),
  error: z.string().optional(),
  signal: z.string().nullable().optional(),
}).strict();

const liveSessions = new Set<string>();
const busyStore = fullToolProfile ? new BusyStore((scope) => {
  const sessionId = scope.startsWith("session:") ? scope.slice("session:".length) : scope;
  return liveSessions.has(sessionId) || processManager.hasLiveScope(scope);
}) : undefined;

function resultData(value: unknown, id: string): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), caller_id: id }
    : { value, caller_id: id };
}

function textResult(value: unknown, id: string) {
  const data = resultData(value, id);
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

async function structuredTextResult(value: unknown, id: string) {
  const data = resultData(value, id);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export function processRuntimeStatus(): { live_process_count: number } {
  return { live_process_count: processManager.liveProcessCount() };
}

export function markSessionLive(sessionId: string, live: boolean): void {
  if (live) liveSessions.add(sessionId);
  else liveSessions.delete(sessionId);
}

export function createServer(callerId: string): McpServer {
  const server = new McpServer({ name: "shell-mcp", version: "0.1.0" });
  registerFileTransferTools(server, callerId);
  registerTemplateCompatibilityResources(server);

  if (fullToolProfile) {
  server.registerTool(
      "view_image",
    {
      description: "Inspect one local PNG, JPEG, GIF, or WebP file for model-only visual analysis. This tool does not attach or display the file in the user's chat. Call at most once per artifact and never retry it as a delivery mechanism.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({ path: z.string().min(1) }),
    },
    async ({ path }) => {
      const result = await viewImage(path);
      return { content: [{ type: "text" as const, text: JSON.stringify({ caller_id: callerId }) }, ...result.content] };
    },
  );
  }

  server.registerTool(
    "start_process",
    {
      description: legacyStartProcessCommandVisible
        ? "Execute a local process. Input forms: executable+args with optional stdin/env, script+language with optional env for PowerShell/Python/Node/Bash source, or legacy command for shell composition. Structured source is transported through stdin. wait_ms defaults to 750 ms and is bounded to 0..10000 ms."
        : "Execute a local process. Input forms: executable+args with optional stdin/env, or script+language with optional env for PowerShell/Python/Node/Bash source. Structured source is transported through stdin. wait_ms defaults to 750 ms and is bounded to 0..10000 ms.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: startProcessInputSchema,
      outputSchema: processOutputSchema,
    },
    async (input) => {
      const typedInput = input as typeof input & { command?: string };
      const { working_directory, wait_ms, activity_target, action_class } = typedInput;
      const value = typedInput.command !== undefined
        ? await processManager.startWithWait(typedInput.command, working_directory, callerId, wait_ms ?? 750, activity_target, action_class)
        : typedInput.executable !== undefined
          ? await processManager.startStructuredWithWait(typedInput.executable, typedInput.args ?? [], working_directory, callerId, wait_ms ?? 750, activity_target, action_class, typedInput.stdin, typedInput.env)
          : await processManager.startScriptWithWait(typedInput.language!, typedInput.script!, working_directory, callerId, wait_ms ?? 750, activity_target, action_class, typedInput.env);
      return structuredTextResult(value, callerId);
    },
  );

  server.registerTool(
    "read_output",
    {
      description: "Read process stdout/stderr or a named bootstrap snapshot. Returns structured data only; it never mounts an app/widget template. wait_ms may wait up to 10000 ms for output or exit, and each stream is bounded to 32000 characters.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        process_id: z.string().min(1),
        max_chars: z.number().int().min(1).max(32_000).optional(),
        wait_ms: z.number().int().min(0).max(10_000).optional(),
      }),
      outputSchema: processOutputSchema,
    },
    async ({ process_id, max_chars, wait_ms }) => structuredTextResult(isBootstrapSnapshot(process_id)
      ? await readBootstrapSnapshot(max_chars ?? 32_000, process_id)
      : await processManager.readOutput(process_id, max_chars, wait_ms), callerId),
  );

  server.registerTool(
    "kill_process",
    {
      description: "Terminate a background process and its entire Windows process tree.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: z.object({ process_id: z.string().min(1) }),
      outputSchema: killProcessOutputSchema,
    },
    async ({ process_id }) => structuredTextResult(await processManager.kill(process_id), callerId),
  );

  if (fullToolProfile) {
  server.registerTool(
      "busy_list",
    {
      description: "List current exact-scope BUSY claims.",
      // Explicit empty shape, not an omitted inputSchema. Omitting it makes the SDK
      // advertise {"type":"object","properties":{}} with no $schema dialect, unlike
      // every other tool here; strict clients reject that tool on first call.
      inputSchema: z.object({}),
    },
    async () => textResult({ claims: await busyStore!.list() }, callerId),
  );

  server.registerTool(
    "busy_claim",
    {
      description: "Claim one exact scope for an actor, or report the existing claim without changing it.",
      inputSchema: z.object({ actor: z.string().min(1), scope: z.string().min(1) }),
    },
    async ({ actor, scope }) => textResult(await busyStore!.claim(actor, scope), callerId),
  );

  server.registerTool(
    "busy_release",
    {
      description: "Release only the named actor's claim for one exact scope.",
      inputSchema: z.object({ actor: z.string().min(1), scope: z.string().min(1) }),
    },
    async ({ actor, scope }) => textResult(await busyStore!.release(actor, scope), callerId),
  );
  }

  return server;
}
