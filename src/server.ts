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

function structuredTextResult(value: unknown, id: string) {
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
      description: "Start a noninteractive PowerShell process. wait_ms controls how long the call may wait for completion before returning a process_id; the default is 750 ms and the supported range is 0 to 10 seconds.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: z.object({
        command: z.string().min(1),
        working_directory: z.string().optional(),
        wait_ms: z.number().int().min(0).max(10_000).optional(),
        activity_target: activityTargetSchema.optional(),
        action_class: actionClassSchema.optional(),
      }),
      outputSchema: processOutputSchema,
    },
    async ({ command, working_directory, wait_ms, activity_target, action_class }) => structuredTextResult(await processManager.startWithWait(command, working_directory, callerId, wait_ms ?? 750, activity_target, action_class), callerId),
  );

  server.registerTool(
    "read_output",
    {
      description: "Read a bounded tail of accumulated stdout and stderr for a process_id. wait_ms optionally sets the maximum wait for output or process exit; 0 is nonblocking. An unchanged timed wait returns no_change=true. elapsed_ms is process age. Each stream is limited to 32,000 characters.",
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
