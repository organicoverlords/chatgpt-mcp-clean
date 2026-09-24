import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolve } from "node:path";
import { isBootstrapSnapshot, readBootstrapSnapshot } from "./lib/bootstrap-snapshot.js";
import { z } from "zod";
import { ProcessManager } from "./lib/process-manager.js";
import { prepareMarkedArtifactHandoffs, registerArtifactFileResource } from "./lib/file-transfer.js";

// V3 MCP is transport/process only. Scheduling and coordination live in the V3 stack.
const toolProfile = (process.env.MCP_TOOL_PROFILE || "process").trim().toLowerCase();
if (toolProfile !== "process") throw new Error("MCP_TOOL_PROFILE must be process");
const configuredMaxLiveProcessesRaw = process.env.MCP_MAX_LIVE_PROCESSES?.trim();
const configuredMaxLiveProcesses = configuredMaxLiveProcessesRaw ? Number(configuredMaxLiveProcessesRaw) : undefined;
const configuredDefaultExecutionTarget = (process.env.MCP_DEFAULT_EXECUTION_TARGET || "local").trim().toLowerCase();
if (configuredDefaultExecutionTarget !== "local" && configuredDefaultExecutionTarget !== "omen") {
  throw new Error("MCP_DEFAULT_EXECUTION_TARGET must be local or omen");
}
const defaultExecutionTarget = configuredDefaultExecutionTarget as "local" | "omen";
const nativeOmenHost = process.env.MCP_NATIVE_OMEN_HOST === "1";
const omenMcpUrl = process.env.MCP_OMEN_MCP_URL?.trim() || undefined;
const OMEN_MCP_PROCESS_PREFIX = "omen-mcp:";
let omenMcpClientPromise: Promise<Client> | undefined;

async function remoteOmenClient(): Promise<Client> {
  if (!omenMcpUrl) throw new Error("omen_mcp_unavailable: MCP_OMEN_MCP_URL is not configured");
  if (!omenMcpClientPromise) {
    omenMcpClientPromise = (async () => {
      const client = new Client({ name: "shell-mcp-omen-proxy", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(omenMcpUrl));
      await client.connect(transport);
      return client;
    })().catch((error) => { omenMcpClientPromise = undefined; throw error; });
  }
  return omenMcpClientPromise;
}

async function callRemoteOmenTool(name: "start_process" | "read_output" | "kill_process", args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = await remoteOmenClient();
  try {
    const reply = await client.callTool({ name, arguments: args });
    if (reply.isError) throw new Error(`omen_mcp_tool_error:${name}`);
    const value = reply.structuredContent;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`omen_mcp_invalid_structured_result:${name}`);
    return value as Record<string, unknown>;
  } catch (error) {
    omenMcpClientPromise = undefined;
    throw error;
  }
}

function remoteProcessId(processId: string): string { return `${OMEN_MCP_PROCESS_PREFIX}${processId}`; }
function localRemoteProcessId(processId: string): string | undefined { return processId.startsWith(OMEN_MCP_PROCESS_PREFIX) ? processId.slice(OMEN_MCP_PROCESS_PREFIX.length) : undefined; }
function remoteProcessResult(value: Record<string, unknown>): Record<string, unknown> {
  const rawId = typeof value.process_id === "string" ? value.process_id : undefined;
  const executionIdentity = value.serving_identity;
  return {
    ...value,
    ...(rawId ? { process_id: remoteProcessId(rawId) } : {}),
    execution_target: "omen",
    execution_transport: "native-mcp",
    ...(executionIdentity && typeof executionIdentity === "object" && !Array.isArray(executionIdentity) ? { execution_serving_identity: executionIdentity } : {}),
  };
}

const processManager = new ProcessManager({
  receiptDirectory: resolve(process.env.MCP_PROCESS_RECEIPT_DIR || ".state/process-receipts"),
  ...(configuredMaxLiveProcesses !== undefined ? { maxLiveTotal: configuredMaxLiveProcesses } : {}),
});
const defaultOmenExecPath = process.platform === "win32" && process.env.USERPROFILE
  ? resolve(process.env.USERPROFILE, "Desktop", "vault", "tools", "omen_exec.py")
  : undefined;
const omenExecPath = process.env.MCP_OMEN_EXEC_PATH?.trim() || defaultOmenExecPath;
const omenPython = process.env.MCP_OMEN_PYTHON?.trim() || "python";
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
  working_directory: z.string().describe("Working directory on the selected execution target.").optional(),
  execution_target: z.enum(["local", "omen"]).describe("Execution target; local by default, or OMEN. On a native OMEN MCP host, OMEN executes locally without SSH.").optional(),
  wait_ms: z.number().int().min(0).max(240_000).optional(),
  activity_target: activityTargetSchema.optional(),
  action_class: actionClassSchema.optional(),
};
const startProcessInputSchema = z.object({
  executable: z.string().min(1).describe("Program name or absolute executable path; paired with args and optional stdin; no shell re-parsing.").optional(),
  args: z.array(z.string()).max(512).describe("Argument vector passed directly to executable without shell re-parsing.").optional(),
  stdin: z.string().max(1_000_000).describe("Optional standard input passed directly to executable.").optional(),
  env: processEnvironmentSchema.describe("Child-process environment overrides for executable or script input.").optional(),
  script: z.string().min(1).max(1_000_000).describe("Multiline source text for the selected runtime; transported through stdin.").optional(),
  language: z.enum(["powershell", "python", "node", "bash"]).describe("Runtime for script.").optional(),
  ...startProcessCommonShape,
}).strict().superRefine((value, ctx) => {
  const input = value;
  const structured = input.executable !== undefined;
  const scripted = input.script !== undefined;
  if (Number(structured) + Number(scripted) !== 1) ctx.addIssue({ code: "custom", message: "provide exactly one of executable or script" });
  if (!structured && input.args !== undefined) ctx.addIssue({ code: "custom", path: ["args"], message: "args is only valid with executable" });
  if (!structured && input.stdin !== undefined) ctx.addIssue({ code: "custom", path: ["stdin"], message: "stdin is only valid with executable" });
  if (scripted !== (input.language !== undefined)) ctx.addIssue({ code: "custom", path: ["language"], message: "language is required exactly when script is provided" });
  if (input.execution_target === "omen") {
    if (!structured) ctx.addIssue({ code: "custom", path: ["execution_target"], message: "OMEN execution requires executable+args" });
    if (input.stdin !== undefined) ctx.addIssue({ code: "custom", path: ["stdin"], message: "stdin is not supported for OMEN execution" });
    if (input.env !== undefined) ctx.addIssue({ code: "custom", path: ["env"], message: "env is not supported for OMEN execution" });
  }
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
  retry_without_change: z.literal(false),
  retry_requires_change: z.literal(true),
  suggested_action: z.enum(["fix_source", "use_structured_python_script", "use_structured_executable_args", "fix_argv_contract", "fix_executable_or_path", "inspect_process_error"]),
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

export const PROCESS_TOOL_CONTRACT_VERSION = "process-tools.v4" as const;

export type ProcessServingIdentity = {
  backend_generation?: string;
  source_commit?: string;
};

const processServingIdentitySchema = z.object({
  tool_contract_version: z.literal(PROCESS_TOOL_CONTRACT_VERSION),
  backend_generation: z.string().min(1).optional(),
  source_commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
}).strict();

// start_process may return either its immediate launch receipt or the same completed/read
// shape as read_output. read_output also serves the bounded bootstrap/timeline snapshots.
// Keep one strict object schema for that shared result family so future top-level fields
// cannot silently bypass MCP structured-output validation.
const processOutputSchema = z.object({
  caller_id: z.string(),
  serving_identity: processServingIdentitySchema,
  execution_serving_identity: processServingIdentitySchema.optional(),
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
  execution_target: z.enum(["local", "omen"]).optional(),
  execution_transport: z.enum(["native-mcp", "ssh-adapter"]).optional(),
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
  serving_identity: processServingIdentitySchema,
  execution_serving_identity: processServingIdentitySchema.optional(),
  execution_target: z.enum(["local", "omen"]).optional(),
  execution_transport: z.enum(["native-mcp", "ssh-adapter"]).optional(),
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

function resultData(value: unknown, id: string, servingIdentity?: Record<string, unknown>): Record<string, unknown> {
  const base = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), caller_id: id }
    : { value, caller_id: id };
  return servingIdentity ? { ...base, serving_identity: servingIdentity } : base;
}

function textResult(value: unknown, id: string) {
  const data = resultData(value, id);
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

async function structuredTextResult(value: unknown, id: string, servingIdentity: Record<string, unknown>) {
  const data = resultData(value, id, servingIdentity);
  const handoffs = await prepareMarkedArtifactHandoffs(value);
  return {
    // structuredContent is the canonical model-visible process result. Do not mirror the
    // same JSON into text content: ChatGPT may treat that duplicate channel as a second
    // result/resource path, which adds avoidable tool-card churn. Native artifact blocks
    // still ride CallToolResult content because they are not representable in the schema.
    content: handoffs.flatMap((handoff) => handoff.content || []),
    structuredContent: data,
  };
}

export function processRuntimeStatus(): { live_process_count: number } {
  return { live_process_count: processManager.liveProcessCount() };
}

export function createServer(callerId: string, runtimeIdentity: ProcessServingIdentity = {}): McpServer {
  const servingIdentity = {
    tool_contract_version: PROCESS_TOOL_CONTRACT_VERSION,
    ...(runtimeIdentity.backend_generation ? { backend_generation: runtimeIdentity.backend_generation } : {}),
    ...(runtimeIdentity.source_commit ? { source_commit: runtimeIdentity.source_commit } : {}),
  };
  const server = new McpServer({ name: "shell-mcp", version: "0.1.0" });
  registerArtifactFileResource(server, callerId);


  server.registerTool(
    "start_process",
    {
      description: "Execute a process locally or on the configured OMEN target and return structured process output.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: startProcessInputSchema,
      outputSchema: processOutputSchema,
    },
    async (input) => {
      const { working_directory, execution_target, wait_ms, activity_target, action_class } = input;
      const target = execution_target ?? defaultExecutionTarget;
      let value: Record<string, unknown>;
      if (target === "omen") {
        if (nativeOmenHost) {
          if (process.platform === "win32") throw new Error("native_omen_host_misconfigured: MCP_NATIVE_OMEN_HOST requires a non-Windows host");
          value = await processManager.startStructuredWithWait(
            input.executable!,
            input.args ?? [],
            working_directory ?? process.env.HOME ?? process.cwd(),
            callerId,
            wait_ms ?? 240_000,
            activity_target,
            action_class,
          );
          value = { ...value, execution_target: "omen", execution_transport: "native-mcp" };
        } else if (omenMcpUrl) {
          value = remoteProcessResult(await callRemoteOmenTool("start_process", {
            executable: input.executable!,
            args: input.args ?? [],
            ...(working_directory ? { working_directory } : {}),
            execution_target: "omen",
            ...(wait_ms !== undefined ? { wait_ms } : {}),
            ...(activity_target ? { activity_target } : {}),
            ...(action_class ? { action_class } : {}),
          }));
        } else {
          if (!omenExecPath) throw new Error("omen_execution_unavailable: MCP_OMEN_EXEC_PATH is not configured and no Windows default is available");
          value = await processManager.startStructuredWithWait(
            omenPython,
            [omenExecPath, "--invocation-source", "mcp", "--cwd", working_directory ?? "/home/aatuska", "--", input.executable!, ...(input.args ?? [])],
            undefined,
            callerId,
            wait_ms ?? 240_000,
            activity_target,
            action_class,
          );
          value = { ...value, execution_target: "omen", execution_transport: "ssh-adapter" };
        }
      } else {
        value = input.executable !== undefined
          ? await processManager.startStructuredWithWait(input.executable, input.args ?? [], working_directory, callerId, wait_ms ?? 750, activity_target, action_class, input.stdin, input.env)
          : await processManager.startScriptWithWait(input.language!, input.script!, working_directory, callerId, wait_ms ?? 750, activity_target, action_class, input.env);
      }
      return structuredTextResult(value, callerId, servingIdentity);
    },
  );

  server.registerTool(
    "read_output",
    {
      description: "Read bounded stdout/stderr from an existing process or supported snapshot alias.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        process_id: z.string().min(1),
        max_chars: z.number().int().optional(),
        wait_ms: z.number().int().min(0).max(240_000).optional(),
      }),
      outputSchema: processOutputSchema,
    },
    async ({ process_id, max_chars, wait_ms }) => {
      const boundedMaxChars = Math.max(1, Math.min(max_chars ?? 100_000, 100_000));
      const remoteId = localRemoteProcessId(process_id);
      const value = remoteId !== undefined
        ? remoteProcessResult(await callRemoteOmenTool("read_output", { process_id: remoteId, max_chars: boundedMaxChars, ...(wait_ms !== undefined ? { wait_ms } : {}) }))
        : (isBootstrapSnapshot(process_id)
          ? await readBootstrapSnapshot(boundedMaxChars, process_id, callerId)
          : await processManager.readOutput(process_id, boundedMaxChars, wait_ms));
      return structuredTextResult(value, callerId, servingIdentity);
    },
  );


  server.registerTool(
    "kill_process",
    {
      description: "Terminate a process and its child process tree.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: z.object({ process_id: z.string().min(1) }),
      outputSchema: killProcessOutputSchema,
    },
    async ({ process_id }) => {
      const remoteId = localRemoteProcessId(process_id);
      const value = remoteId !== undefined
        ? remoteProcessResult(await callRemoteOmenTool("kill_process", { process_id: remoteId }))
        : await processManager.kill(process_id);
      return structuredTextResult(value, callerId, servingIdentity);
    },
  );


  return server;
}
