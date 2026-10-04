import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolve } from "node:path";
import { isBootstrapSnapshot, readBootstrapSnapshot } from "./lib/bootstrap-snapshot.js";
import { z } from "zod";
import { BusyStore } from "./lib/busy-store.js";
import { ProcessManager, commandPreflightAsync, processFailureDiagnostic, structuredCommandDisplay, structuredPolicyText, replayStructuredArgvTransportError, replayStructuredHostPreflightError } from "./lib/process-manager.js";
import { planStructuredExecution, planStructuredScript, type StructuredScriptLanguage } from "./lib/command-execution-plan.js";
import { currentTelemetryContext } from "./lib/transport-telemetry.js";
import { structuredInvocation, scriptInvocation } from "./lib/structured-invocation.js";

// The deployed ChatGPT connector surface is the process profile. Keep the broader
// full profile explicit-only for internal/local tests so repo inspection without a
// deployment-specific environment cannot silently advertise non-plugin tools.
const toolProfile = (process.env.MCP_TOOL_PROFILE || "process").trim().toLowerCase();
if (toolProfile !== "full" && toolProfile !== "process") throw new Error("MCP_TOOL_PROFILE must be full or process");
const fullToolProfile = toolProfile === "full";
const configuredMaxLiveProcessesRaw = process.env.MCP_MAX_LIVE_PROCESSES?.trim();
const configuredMaxLiveProcesses = configuredMaxLiveProcessesRaw ? Number(configuredMaxLiveProcessesRaw) : undefined;
const configuredDefaultExecutionTarget = (process.env.MCP_DEFAULT_EXECUTION_TARGET || "local").trim().toLowerCase();
if (configuredDefaultExecutionTarget !== "local" && configuredDefaultExecutionTarget !== "omen") {
  throw new Error("MCP_DEFAULT_EXECUTION_TARGET must be local or omen");
}
const defaultExecutionTarget = configuredDefaultExecutionTarget as "local" | "omen";
const nativeOmenHost = process.env.MCP_NATIVE_OMEN_HOST === "1";
const omenMcpUrl = process.env.MCP_OMEN_MCP_URL?.trim() || undefined;
const allowOmenSshFallback = process.env.MCP_ALLOW_OMEN_SSH_FALLBACK === "1";
const OMEN_MCP_PROCESS_PREFIX = "omen-mcp:";
const localEnginePortByBindingPort: Record<string, number> = { "3212": 3513, "3312": 3516, "3420": 3515 };
const localEngineUrl = process.env.MCP_LOCAL_ENGINE_URL?.trim()
  || (process.env.PORT && localEnginePortByBindingPort[process.env.PORT]
    ? "http://127.0.0.1:" + localEnginePortByBindingPort[process.env.PORT] + "/mcp"
    : undefined);
const LOCAL_ENGINE_PROCESS_PREFIX = "local-rust:";
const previousLocalEngineUrls = [...new Set((process.env.MCP_LOCAL_ENGINE_PREVIOUS_URL || "")
  .split(",").map(url => url.trim()).filter(Boolean))];
const previousLocalEngineClients = new Map<string, Promise<Client>>();
const previousEngineReadShapes = new Map<string, { readers: boolean; wait: number }>();
let localEngineClientPromise: Promise<Client> | undefined;
async function previousLocalEngineClient(url: string): Promise<Client> {
  let promise = previousLocalEngineClients.get(url);
  if (!promise) {
    const client = new Client({ name: "shell-mcp-retained-process-reader", version: "1" });
    promise = client.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout: 2000 })
      .then(async () => {
        const listed = await client.listTools({}, { timeout: 2000 });
        const read = listed.tools.find(tool => tool.name === "read_output")?.inputSchema as any;
        previousEngineReadShapes.set(url, { readers: Boolean(read?.properties?.reader_id), wait: Number(read?.$defs?.WaitMs?.maximum ?? 5000) });
        return client;
      }).catch(error => { previousLocalEngineClients.delete(url); throw error; });
    previousLocalEngineClients.set(url, promise);
  }
  return promise;
}

function localEngineClient(): Promise<Client> {
  if (!localEngineUrl) throw new Error("local_process_engine_unavailable: MCP_LOCAL_ENGINE_URL is not configured");
  if (!localEngineClientPromise) {
    const client = new Client({ name: "shell-mcp-local-rust-engine", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(localEngineUrl));
    localEngineClientPromise = client.connect(transport, { timeout: 2000 }).then(() => client).catch((error) => {
      localEngineClientPromise = undefined;
      throw error;
    });
  }
  return localEngineClientPromise;
}

async function callLocalEngineTool(
  name: "start_process" | "read_output" | "kill_process",
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const client = await localEngineClient();
  let reply = await client.callTool({ name, arguments: args }, undefined, { timeout: Math.max(10_000, Number(args.wait_ms ?? 0) + 10_000), maxTotalTimeout: 250_000, ...(signal ? { signal } : {}) });
  const errorText = (value: typeof reply) => Array.isArray(value.content)
    ? value.content.filter((item): item is { type: "text"; text: string } =>
        Boolean(item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string"))
      .map(item => item.text).join("\n") : "";
  // IDs returned before cutover remain readable/killable on their original engine.
  if (name !== "start_process") {
    for (const url of previousLocalEngineUrls) {
      if (!reply.isError || !/^unknown process_id$/.test(errorText(reply).trim())) break;
      try {
        const previousClient = await previousLocalEngineClient(url);
        const shape = previousEngineReadShapes.get(url);
        const forwarded = { ...args, ...(name === "read_output" ? { wait_ms: Math.min(Number(args.wait_ms ?? 0), shape?.wait ?? 5000), ...(shape?.readers ? {} : { reader_id: undefined }) } : {}) };
        reply = await previousClient.callTool({ name, arguments: forwarded }, undefined, { timeout: Math.max(10_000, Number(forwarded.wait_ms ?? 0) + 10_000), maxTotalTimeout: 250_000, ...(signal ? { signal } : {}) });
      } catch (error) {
        if (signal?.aborted) throw error;
        previousLocalEngineClients.delete(url);
        console.error("retained engine unavailable:", url, error instanceof Error ? error.message : String(error));
      }
    }
  }
  if (reply.isError) throw new Error("local_process_engine_tool_error:" + name + ": " + errorText(reply));
  if (reply.structuredContent && typeof reply.structuredContent === "object" && !Array.isArray(reply.structuredContent)) {
    return reply.structuredContent as Record<string, unknown>;
  }
  const text = Array.isArray(reply.content)
    ? reply.content
      .filter((item): item is { type: "text"; text: string } =>
        Boolean(item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string"))
      .map((item) => item.text)
      .join("\n")
    : "";
  if (!text) throw new Error("local_process_engine_invalid_result:" + name);
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("local_process_engine_invalid_result:" + name);
  return parsed as Record<string, unknown>;
}

type LocalEngineProcessMeta = {
  execution_mode: "native" | "explicit_shell" | "powershell";
  execution_reason: string;
  command?: string;
  activity_target?: z.infer<typeof activityTargetSchema>;
  action_class?: string;
  stdout_cursor?: number;
  stderr_cursor?: number;
  diagnostic_stdout?: string;
  diagnostic_stderr?: string;
};

const localEngineProcessMeta = new Map<string, LocalEngineProcessMeta>();
const MAX_LOCAL_ENGINE_CACHE_ENTRIES = 512;

function trimLocalEngineCaches(): void {
  for (const cache of [localEngineProcessMeta]) {
    while (cache.size > MAX_LOCAL_ENGINE_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
}

function localEngineProcessResult(
  value: Record<string, unknown>,
  pageLimit = 30_000,
  metaOverride?: LocalEngineProcessMeta,
): Record<string, unknown> {
  const rawProcessId = typeof value.process_id === "string" ? value.process_id : "";
  const processId = LOCAL_ENGINE_PROCESS_PREFIX + rawProcessId;
  const context = value.context && typeof value.context === "object" ? value.context as LocalEngineProcessMeta : undefined;
  const meta = metaOverride ?? localEngineProcessMeta.get(rawProcessId) ?? context;
  const stdout = typeof value.stdout === "string" ? value.stdout : "";
  const stderr = typeof value.stderr === "string" ? value.stderr : "";
  if (meta) {
    meta.diagnostic_stdout = ((meta.diagnostic_stdout ?? "") + stdout).slice(-8_000);
    meta.diagnostic_stderr = ((meta.diagnostic_stderr ?? "") + stderr).slice(-8_000);
  }
  const failureDiagnostic = processFailureDiagnostic(meta?.command ?? (typeof value.command === "string" ? value.command : ""), meta?.diagnostic_stdout ?? stdout, meta?.diagnostic_stderr ?? stderr,
    typeof value.exit_code === "number" ? value.exit_code : null, typeof value.error_code === "string" ? stderr || value.error_code : undefined, meta?.execution_reason, typeof value.error_code === "string" ? value.error_code : undefined);
  const stdoutDropped = typeof value.stdout_truncated_bytes === "number" ? value.stdout_truncated_bytes : 0;
  const stderrDropped = typeof value.stderr_truncated_bytes === "number" ? value.stderr_truncated_bytes : 0;
  const more = value.next_action === "READ_SAME_PROCESS_ID";
  const page = value.output_page && typeof value.output_page === "object" ? value.output_page as Record<string, unknown> : {};
  const stdoutStart = typeof page.stdout_start === "number" ? page.stdout_start : (meta?.stdout_cursor ?? 0) + stdoutDropped;
  const stderrStart = typeof page.stderr_start === "number" ? page.stderr_start : (meta?.stderr_cursor ?? 0) + stderrDropped;
  const stdoutEnd = typeof page.stdout_end === "number" ? page.stdout_end : stdoutStart + stdout.length;
  const stderrEnd = typeof page.stderr_end === "number" ? page.stderr_end : stderrStart + stderr.length;
  if (meta) { meta.stdout_cursor = stdoutEnd; meta.stderr_cursor = stderrEnd; }
  const effectivePageLimit = Math.max(1, Math.min(30_000, pageLimit));
  return {
    mcp_status: "OK",
    process_state: value.process_state === "RUNNING" ? "RUNNING" : "COMPLETED",
    elapsed_ms: typeof value.elapsed_ms === "number" ? value.elapsed_ms : 0,
    next_action: more ? "READ_SAME_PROCESS_ID" : "STOP_READING",
    process_id: processId,
    ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
    running: value.running === true,
    execution_target: nativeOmenHost ? "omen" : "local",
    execution_transport: "native-mcp",
    ...(meta ? { execution_mode: meta.execution_mode, execution_reason: meta.execution_reason } : {}),
    ...(failureDiagnostic ? { failure_diagnostic: failureDiagnostic } : {}),
    ...(meta?.activity_target ? { activity_target: meta.activity_target } : {}),
    ...(meta?.action_class ? { action_class: meta.action_class } : {}),
    ...(typeof value.error_code === "string" ? { error_code: value.error_code } : {}),
    stdout,
    stderr,
    ...(typeof value.exit_code === "number" || value.exit_code === null ? { exit_code: value.exit_code } : {}),
    ...(stdoutDropped > 0 ? { stdout_truncated: true, stdout_dropped_from_start: typeof value.stdout_dropped_chars === "number" ? value.stdout_dropped_chars : stdoutDropped } : {}),
    ...(stderrDropped > 0 ? { stderr_truncated: true, stderr_dropped_from_start: typeof value.stderr_dropped_chars === "number" ? value.stderr_dropped_chars : stderrDropped } : {}),
    ...(typeof value.command === "string" ? { command: value.command } : {}),
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(typeof value.started_at === "string" ? { started_at: value.started_at } : {}),
    ...(typeof value.finished_at === "string" || value.finished_at === null ? { finished_at: value.finished_at } : {}),
    ...(typeof value.signal === "string" || value.signal === null ? { signal: value.signal } : {}),
    ...(typeof value.request_id === "string" ? { request_id: value.request_id } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.stdout_sha256 === "string" ? {
      audit_schema: "process-output-evidence.v1", stdout_sha256: value.stdout_sha256, stderr_sha256: value.stderr_sha256,
      retained_stdout_bytes: value.retained_stdout_bytes, retained_stderr_bytes: value.retained_stderr_bytes,
      retained_output_bytes: Number(value.retained_stdout_bytes) + Number(value.retained_stderr_bytes),
      retained_stdout_chars: value.retained_stdout_chars, retained_stderr_chars: value.retained_stderr_chars,
      retained_output_chars: Number(value.retained_stdout_chars) + Number(value.retained_stderr_chars),
      evidence_completeness: value.evidence_completeness, execution_outcome: value.execution_outcome,
    } : {}),
    output_page: {
      stdout_start: stdoutStart,
      stdout_end: stdoutEnd,
      stdout_total: typeof page.stdout_total === "number" ? page.stdout_total : stdoutEnd,
      stderr_start: stderrStart,
      stderr_end: stderrEnd,
      stderr_total: typeof page.stderr_total === "number" ? page.stderr_total : stderrEnd,
      page_chars: stdout.length + stderr.length,
      page_limit: effectivePageLimit,
      more,
    },
  };
}

function rememberLocalEngineStart(
  value: Record<string, unknown>,
  meta: LocalEngineProcessMeta,
): Record<string, unknown> {
  const rawProcessId = typeof value.process_id === "string" ? value.process_id : "";
  if (rawProcessId) {
    localEngineProcessMeta.set(rawProcessId, meta);
    trimLocalEngineCaches();
  }
  return localEngineProcessResult(value, 30_000, meta);
}

function localEngineKillResult(value: Record<string, unknown>): Record<string, unknown> {
  const rawProcessId = typeof value.process_id === "string" ? value.process_id : "";
  const processId = LOCAL_ENGINE_PROCESS_PREFIX + rawProcessId;
  const running = value.running === true;
  const requested = value.kill_requested === true;
  if (!running) {
    localEngineProcessMeta.delete(rawProcessId);
  }
  return {
    process_id: processId,
    pid: typeof value.pid === "number" ? value.pid : 0,
    killed: requested && !running,
    ...(!requested && !running ? { already_exited: true } : {}),
    ...(requested ? { kill_requested: true } : {}),
    running,
    execution_target: nativeOmenHost ? "omen" : "local",
    execution_transport: "native-mcp",
  };
}

function localEngineProcessId(processId: string): string | undefined {
  return processId.startsWith(LOCAL_ENGINE_PROCESS_PREFIX)
    ? processId.slice(LOCAL_ENGINE_PROCESS_PREFIX.length)
    : undefined;
}

type OmenClientEntry = { promise: Promise<Client>; active: number; lastUsedAt: number };
const omenMcpClients = new Map<string, OmenClientEntry>();
const OMEN_CLIENT_IDLE_MS = 10 * 60_000;
const OMEN_CLIENT_CACHE_LIMIT = 64;
const MODEL_VISIBLE_PAGE_MAX_CHARS = 30_000;
const bootstrapAliasProcesses = new Map<string, string>();

function bootstrapAliasCommand(): { executable: string; args: string[]; cwd?: string } {
  const configuredExecutable = process.env.MCP_BOOTSTRAP_ALIAS_EXECUTABLE?.trim();
  const configuredCwd = process.env.MCP_BOOTSTRAP_ALIAS_CWD?.trim();
  const configuredArgs = process.env.MCP_BOOTSTRAP_ALIAS_ARGS_JSON?.trim();
  let args: string[] = [];
  if (configuredArgs) {
    const parsed = JSON.parse(configuredArgs);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      throw new Error("MCP_BOOTSTRAP_ALIAS_ARGS_JSON must be a JSON string array");
    }
    args = parsed;
  }
  if (configuredExecutable) {
    return { executable: configuredExecutable, args, ...(configuredCwd ? { cwd: configuredCwd } : {}) };
  }
  const home = process.env.USERPROFILE?.trim() || process.env.HOME?.trim();
  const executable = home
    ? resolve(home, ".local", "bin", process.platform === "win32" ? "bootstrap.exe" : "bootstrap")
    : "bootstrap";
  return { executable, args, ...(configuredCwd ? { cwd: configuredCwd } : {}) };
}

function publicBootstrapAliasOutput(value: Record<string, unknown>): Record<string, unknown> {
  const { command: _command, submitted_command: _submittedCommand, cwd: _cwd, ...publicValue } = value;
  return { ...publicValue, process_id: "bootstrap", bootstrap_alias: true };
}

function pruneOmenClients(): void {
  const now = Date.now();
  for (const [callerId, entry] of omenMcpClients) {
    if (entry.active > 0 || (omenMcpClients.size <= OMEN_CLIENT_CACHE_LIMIT && now - entry.lastUsedAt < OMEN_CLIENT_IDLE_MS)) continue;
    omenMcpClients.delete(callerId);
    void entry.promise.then((client) => client.close()).catch(() => undefined);
  }
}

export async function closeRemoteOmenClients(): Promise<void> {
  const entries = [...omenMcpClients.values()];
  omenMcpClients.clear();
  await Promise.all(entries.map((entry) => entry.promise.then((client) => client.close()).catch(() => undefined)));
}

function remoteOmenClient(callerId: string): OmenClientEntry {
  if (!omenMcpUrl) throw new Error("omen_mcp_unavailable: MCP_OMEN_MCP_URL is not configured");
  pruneOmenClients();
  let entry = omenMcpClients.get(callerId);
  if (!entry) {
    const client = new Client({ name: "shell-mcp-omen-proxy", version: "1" });
    // A transport belongs to one upstream caller. Native OMEN must not see
    // every Windows worker as one shared SDK client/session.
    const transport = new StreamableHTTPClientTransport(new URL(omenMcpUrl), {
      requestInit: { headers: { "x-openai-session": `proxy:${callerId}` } },
    });
    entry = { active: 0, lastUsedAt: Date.now(), promise: client.connect(transport).then(() => client) };
    omenMcpClients.set(callerId, entry);
    const created = entry;
    void created.promise.catch(() => {
      if (omenMcpClients.get(callerId) === created) omenMcpClients.delete(callerId);
    });
  }
  entry.active += 1;
  entry.lastUsedAt = Date.now();
  return entry;
}

function remoteOmenToolError(name: string, reply: unknown): Error {
  const content = reply && typeof reply === "object" && "content" in reply && Array.isArray(reply.content) ? reply.content : [];
  const message = content.filter((item): item is { type: "text"; text: string } =>
    Boolean(item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string"))
    .map((item) => item.text).join("\n");
  const code = message.match(/\bstart_process_(?:host_)?concurrency_limited\b/)?.[0];
  if (!code) return new Error(`omen_mcp_tool_error:${name}`);
  const live = message.match(/\blive_process_count=(\d+)\b/)?.[1];
  const limit = message.match(/\bmax_live_processes=(\d+)\b/)?.[1];
  const rejectionId = message.match(/\brejection_id=([0-9a-f-]{36})\b/i)?.[1];
  return new Error(`omen_${code}${live ? `; live_process_count=${live}` : ""}${limit ? `; max_live_processes=${limit}` : ""}${rejectionId ? `; rejection_id=${rejectionId}` : ""}`);
}

async function callRemoteOmenTool(name: "start_process" | "read_output" | "kill_process", args: Record<string, unknown>, callerId: string): Promise<Record<string, unknown>> {
  const entry = remoteOmenClient(callerId);
  let transportFailed = false;
  try {
    const client = await entry.promise;
    const reply = await client.callTool({ name, arguments: args }).catch((error) => { transportFailed = true; throw error; });
    if (reply.isError) throw remoteOmenToolError(name, reply);
    const value = reply.structuredContent;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`omen_mcp_invalid_structured_result:${name}`);
    return value as Record<string, unknown>;
  } catch (error) {
    if (transportFailed && omenMcpClients.get(callerId) === entry) {
      omenMcpClients.delete(callerId);
      void entry.promise.then((client) => client.close()).catch(() => undefined);
    }
    throw error;
  } finally {
    entry.active -= 1;
    entry.lastUsedAt = Date.now();
  }
}

function remoteProcessId(processId: string): string { return `${OMEN_MCP_PROCESS_PREFIX}${processId}`; }
function localRemoteProcessId(processId: string): string | undefined { return processId.startsWith(OMEN_MCP_PROCESS_PREFIX) ? processId.slice(OMEN_MCP_PROCESS_PREFIX.length) : undefined; }
function remoteProcessResult(value: Record<string, unknown>): Record<string, unknown> {
  const rawId = typeof value.process_id === "string" ? value.process_id : undefined;
  const executionCallerId = typeof value.caller_id === "string" ? value.caller_id : undefined;
  const executionIdentity = value.serving_identity;
  return {
    ...value,
    ...(executionCallerId ? { execution_caller_id: executionCallerId } : {}),
    ...(rawId ? { process_id: remoteProcessId(rawId) } : {}),
    execution_target: "omen",
    execution_transport: "native-mcp",
    ...(executionIdentity && typeof executionIdentity === "object" && !Array.isArray(executionIdentity) ? { execution_serving_identity: executionIdentity } : {}),
  };
}

let processManager: ProcessManager | undefined;
function legacyProcesses(): ProcessManager {
  return processManager ??= new ProcessManager({
  receiptDirectory: resolve(process.env.MCP_PROCESS_RECEIPT_DIR || ".state/process-receipts"),
  ...(configuredMaxLiveProcesses !== undefined ? { maxLiveTotal: configuredMaxLiveProcesses } : {}),
});
}
const defaultOmenExecPath = process.platform === "win32" && process.env.USERPROFILE
  ? resolve(process.env.USERPROFILE, "Desktop", "vault", "tools", "omen_exec.py")
  : undefined;
const configuredOmenExecPath = process.env.MCP_OMEN_EXEC_PATH?.trim() || defaultOmenExecPath;
const omenExecPath = allowOmenSshFallback ? configuredOmenExecPath : undefined;
const DEFAULT_INITIAL_WAIT_MS = 750;
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
  read_mode: z.enum(["MATERIALIZED_ONLY", "V3_ROOM_BOUND_READ"]),
}).strict();

// One public contract for every binding. Accept old launch configuration without
// letting it change the advertised schema or returned implementation identity.
const legacyContractRevision = process.env.MCP_TOOL_CONTRACT_VERSION;
if (legacyContractRevision && legacyContractRevision !== "process-tools.v4" && legacyContractRevision !== "process-tools.v6") {
  throw new Error("MCP_TOOL_CONTRACT_VERSION must be process-tools.v4 or process-tools.v6");
}
export const PROCESS_TOOL_CONTRACT_VERSION = "process-tools.v6";

export type ProcessServingIdentity = {
  backend_generation?: string;
  source_commit?: string;
};

const processServingIdentitySchema = z.object({
  tool_contract_version: z.literal(PROCESS_TOOL_CONTRACT_VERSION).describe("Shared process-tool contract; executable implementation is identified by source_commit."),
  backend_generation: z.string().min(1).optional(),
  source_commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
}).strict();

// start_process may return either its immediate launch receipt or the same completed/read
// shape as read_output. read_output also serves the bounded bootstrap/timeline snapshots.
// Keep one strict object schema for that shared result family so future top-level fields
// cannot silently bypass MCP structured-output validation.
const processOutputSchema = z.object({
  caller_id: z.string(),
  execution_caller_id: z.string().optional(),
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
  execution_caller_id: z.string().optional(),
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

const liveSessions = new Set<string>();
const busyStore = fullToolProfile ? new BusyStore((scope) => {
  const sessionId = scope.startsWith("session:") ? scope.slice("session:".length) : scope;
  return liveSessions.has(sessionId) || (processManager?.hasLiveScope(scope) ?? false);
}) : undefined;

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
  return { content: [], structuredContent: data };
}

export async function processRuntimeStatus(): Promise<{ live_process_count: number | null; process_engine_available?: boolean }> {
  if (localEngineUrl) {
    try {
      const counts = await Promise.all([...new Set([localEngineUrl, ...previousLocalEngineUrls])].map(async url => {
        const healthUrl = new URL(url); healthUrl.pathname = "/health";
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(500) });
        if (!response.ok) throw new Error("engine health unavailable");
        const value = await response.json() as { live_process_count?: number };
        if (!Number.isSafeInteger(value.live_process_count) || value.live_process_count! < 0) throw new Error("invalid engine count");
        return value.live_process_count!;
      }));
      return { live_process_count: counts.reduce((sum, count) => sum + count, 0), process_engine_available: true };
    } catch {
      return { live_process_count: null, process_engine_available: false };
    }
  }
  return { live_process_count: legacyProcesses().liveProcessCount() };
}

export function markSessionLive(sessionId: string, live: boolean): void {
  if (live) liveSessions.add(sessionId);
  else liveSessions.delete(sessionId);
}

export function createServer(callerId: string, runtimeIdentity: ProcessServingIdentity = {}): McpServer {
  const servingIdentity = {
    tool_contract_version: PROCESS_TOOL_CONTRACT_VERSION,
    ...(runtimeIdentity.backend_generation ? { backend_generation: runtimeIdentity.backend_generation } : {}),
    ...(runtimeIdentity.source_commit ? { source_commit: runtimeIdentity.source_commit } : {}),
  };
  const server = new McpServer({ name: "shell-mcp", version: "0.1.0" });


  server.registerTool(
    "start_process",
    {
      description: "Execute a process locally or on the configured OMEN target and return structured process output.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      inputSchema: startProcessInputSchema,
      outputSchema: processOutputSchema,
    },
    async (input, extra) => {
      const { working_directory, execution_target, wait_ms, activity_target, action_class } = input;
      const target = execution_target ?? defaultExecutionTarget;
      let value: Record<string, unknown>;
      if (target === "omen" && !(nativeOmenHost && localEngineUrl)) {
        if (nativeOmenHost) {
          if (process.platform === "win32") throw new Error("native_omen_host_misconfigured: MCP_NATIVE_OMEN_HOST requires a non-Windows host");
          const nativeWorkingDirectory = working_directory ?? process.env.HOME ?? process.cwd();
          value = input.executable !== undefined
            ? await legacyProcesses().startStructuredWithWait(
                input.executable,
                input.args ?? [],
                nativeWorkingDirectory,
                callerId,
                wait_ms ?? DEFAULT_INITIAL_WAIT_MS,
                activity_target,
                action_class,
                input.stdin,
                input.env,
                extra.signal,
                MODEL_VISIBLE_PAGE_MAX_CHARS,
              )
            : await legacyProcesses().startScriptWithWait(
                input.language!,
                input.script!,
                nativeWorkingDirectory,
                callerId,
                wait_ms ?? DEFAULT_INITIAL_WAIT_MS,
                activity_target,
                action_class,
                input.env,
                extra.signal,
                MODEL_VISIBLE_PAGE_MAX_CHARS,
              );
          value = { ...value, execution_target: "omen", execution_transport: "native-mcp" };
        } else if (omenMcpUrl) {
          const remoteInput: Record<string, unknown> = input.executable !== undefined
            ? {
                executable: input.executable,
                args: input.args ?? [],
                ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
                ...(input.env !== undefined ? { env: input.env } : {}),
              }
            : {
                script: input.script!,
                language: input.language!,
                ...(input.env !== undefined ? { env: input.env } : {}),
              };
          value = remoteProcessResult(await callRemoteOmenTool("start_process", {
            ...remoteInput,
            ...(working_directory ? { working_directory } : {}),
            execution_target: "omen",
            ...(wait_ms !== undefined ? { wait_ms } : {}),
            ...(activity_target ? { activity_target } : {}),
            ...(action_class ? { action_class } : {}),
          }, callerId));
        } else {
          if (!omenExecPath) throw new Error("omen_native_mcp_required: SSH fallback is disabled; use the native OMEN MCP/Supertest route or explicitly set MCP_ALLOW_OMEN_SSH_FALLBACK=1 for rollback/bootstrap recovery");
          if (input.executable === undefined || input.stdin !== undefined || input.env !== undefined) {
            throw new Error("omen_ssh_adapter_structured_fields_unsupported: native OMEN MCP is required for script, stdin, or env transport");
          }
          value = await legacyProcesses().startStructuredWithWait(
            omenPython,
            [omenExecPath, "--invocation-source", "mcp", "--cwd", working_directory ?? "/home/aatuska", "--", input.executable, ...(input.args ?? [])],
            undefined,
            callerId,
            wait_ms ?? DEFAULT_INITIAL_WAIT_MS,
            activity_target,
            action_class,
            undefined,
            undefined,
            extra.signal,
            MODEL_VISIBLE_PAGE_MAX_CHARS,
          );
          value = { ...value, execution_target: "omen", execution_transport: "ssh-adapter" };
        }
      } else {
        if (localEngineUrl) {
          const invocation = input.executable !== undefined
            ? structuredInvocation(input.executable, input.args ?? [], input.stdin)
            : scriptInvocation(input.language!, input.script!);
          const preflightPlan = input.executable !== undefined
            ? planStructuredExecution(invocation.executable, invocation.args, invocation.stdin, "powershell.exe")
            : planStructuredScript(input.language as StructuredScriptLanguage, input.script!, "powershell.exe");
          const displayCommand = structuredCommandDisplay(invocation.executable, invocation.args);
          const preflightText = structuredPolicyText(displayCommand +
            (invocation.stdin !== undefined ? "\n" + invocation.stdin : ""), input.env);
          const preflightError = replayStructuredArgvTransportError(invocation.executable, invocation.args)
            ?? replayStructuredHostPreflightError(invocation.executable, process.platform)
            ?? await commandPreflightAsync(preflightText, preflightPlan, input.script !== undefined ? "policy" : "full");
          if (preflightError) throw new Error(`start_process_preflight_failed: ${preflightError}`);
          const localStarted = await callLocalEngineTool("start_process", {
            executable: invocation.executable,
            args: invocation.args,
            context: { execution_mode: invocation.execution_mode, execution_reason: invocation.execution_reason,
              ...(activity_target ? { activity_target } : {}), ...(action_class ? { action_class } : {}) },
            cwd: working_directory ?? process.cwd(),
            owner_id: callerId,
            ...(currentTelemetryContext().session_id ? { scope_id: currentTelemetryContext().session_id } : {}),
            ...(currentTelemetryContext().request_id ? { request_id: currentTelemetryContext().request_id } : {}),
            display_command: Array.from(input.script !== undefined ? `[${input.language} script]\n${input.script}` : displayCommand).slice(0, 4000).join(""),
            ...("stdin" in invocation ? { stdin: invocation.stdin } : {}),
            ...(input.env !== undefined ? { env: input.env } : {}),
            wait_ms: wait_ms ?? DEFAULT_INITIAL_WAIT_MS,
          }, extra.signal);
          value = rememberLocalEngineStart(localStarted, { ...(activity_target ? { activity_target } : {}), ...(action_class ? { action_class } : {}), execution_mode: invocation.execution_mode, execution_reason: invocation.execution_reason,
            command: (input.script !== undefined ? `[${input.language} script]\n${input.script}` : displayCommand).slice(0, 4_000) });
        } else {
          value = input.executable !== undefined
            ? await legacyProcesses().startStructuredWithWait(input.executable, input.args ?? [], working_directory, callerId, wait_ms ?? DEFAULT_INITIAL_WAIT_MS, activity_target, action_class, input.stdin, input.env, extra.signal, MODEL_VISIBLE_PAGE_MAX_CHARS)
            : await legacyProcesses().startScriptWithWait(input.language!, input.script!, working_directory, callerId, wait_ms ?? DEFAULT_INITIAL_WAIT_MS, activity_target, action_class, input.env, extra.signal, MODEL_VISIBLE_PAGE_MAX_CHARS);
        }
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
        stdin: z.string().optional(),
        has_attachments: z.boolean().optional(),
        conversation_id: z.string().min(1).optional(),
        message_id: z.string().min(1).optional(),
        expected_room_head: z.string().min(1).optional(),
      }).strict().superRefine((value, ctx) => {
        const roomFields = value.conversation_id !== undefined || value.message_id !== undefined || value.expected_room_head !== undefined;
        if (roomFields && value.process_id !== "bootstrap") {
          ctx.addIssue({ code: "custom", path: ["process_id"], message: "conversation_id, message_id and expected_room_head are valid only for process_id=bootstrap" });
        }
        if ((value.conversation_id === undefined) !== (value.expected_room_head === undefined)) {
          ctx.addIssue({ code: "custom", message: "conversation_id and expected_room_head must be provided together" });
        }
        if (value.stdin !== undefined && value.process_id !== "bootstrap") {
          ctx.addIssue({ code: "custom", path: ["stdin"], message: "stdin on read_output is valid only for process_id=bootstrap lifecycle entry" });
        }
        if (value.has_attachments !== undefined && value.process_id !== "bootstrap") {
          ctx.addIssue({ code: "custom", path: ["has_attachments"], message: "has_attachments on read_output is valid only for process_id=bootstrap lifecycle entry" });
        }
      }),
      outputSchema: processOutputSchema,
    },
    async ({ process_id, max_chars, wait_ms, stdin, has_attachments, conversation_id, message_id, expected_room_head }, extra) => {
      const boundedMaxChars = Math.max(1, Math.min(max_chars ?? MODEL_VISIBLE_PAGE_MAX_CHARS, MODEL_VISIBLE_PAGE_MAX_CHARS));
      if (process_id === "bootstrap" && stdin !== undefined) {
        if (bootstrapAliasProcesses.has(callerId)) {
          throw new Error("bootstrap alias already has an active startup process; keep reading bootstrap without stdin until STOP_READING");
        }
        const command = bootstrapAliasCommand();
        const args = [...command.args];
        if (conversation_id && expected_room_head) {
          args.push("--conversation-id", conversation_id, "--expected-room-head", expected_room_head);
        }
        if (message_id) args.push("--message-id", message_id);
        if (has_attachments === true) args.push("--has-attachments");
        const started = localEngineUrl
          ? rememberLocalEngineStart(await callLocalEngineTool("start_process", {
              executable: command.executable,
              args,
              ...(command.cwd ? { cwd: command.cwd } : {}),
              stdin,
              owner_id: callerId,
              ...(currentTelemetryContext().session_id ? { scope_id: currentTelemetryContext().session_id } : {}),
              ...(currentTelemetryContext().request_id ? { request_id: currentTelemetryContext().request_id } : {}),
              wait_ms: wait_ms ?? DEFAULT_INITIAL_WAIT_MS,
            }, extra.signal), { execution_mode: "native", execution_reason: "structured_argv" })
          : await legacyProcesses().startStructuredWithWait(
              command.executable,
              args,
              command.cwd,
              callerId,
              wait_ms ?? DEFAULT_INITIAL_WAIT_MS,
              undefined,
              "lifecycle",
              stdin,
              undefined,
              extra.signal,
              boundedMaxChars,
            );
        const actualProcessId = started.process_id;
        if (typeof actualProcessId !== "string" || !actualProcessId) throw new Error("bootstrap lifecycle start returned no process identity");
        if (started.next_action === "READ_SAME_PROCESS_ID") bootstrapAliasProcesses.set(callerId, actualProcessId);
        else bootstrapAliasProcesses.delete(callerId);
        return structuredTextResult(publicBootstrapAliasOutput(started), callerId, servingIdentity);
      }
      const activeBootstrapProcessId = process_id === "bootstrap" ? bootstrapAliasProcesses.get(callerId) : undefined;
      if (activeBootstrapProcessId) {
        const engineBootstrapId = localEngineProcessId(activeBootstrapProcessId);
        const read = engineBootstrapId !== undefined
          ? localEngineProcessResult(await callLocalEngineTool("read_output", {
              process_id: engineBootstrapId,
              reader_id: callerId,
              max_chars: boundedMaxChars,
              wait_ms: wait_ms ?? 0,
            }, extra.signal), boundedMaxChars)
          : await legacyProcesses().readOutput(activeBootstrapProcessId, boundedMaxChars, wait_ms, extra.signal);
        if (read.next_action === "STOP_READING") bootstrapAliasProcesses.delete(callerId);
        return structuredTextResult(publicBootstrapAliasOutput(read), callerId, servingIdentity);
      }
      const remoteId = localRemoteProcessId(process_id);
      const engineId = localEngineProcessId(process_id);
      const value = remoteId !== undefined
        ? remoteProcessResult(await callRemoteOmenTool("read_output", { process_id: remoteId, max_chars: boundedMaxChars, ...(wait_ms !== undefined ? { wait_ms } : {}) }, callerId))
        : engineId !== undefined
          ? localEngineProcessResult(await callLocalEngineTool("read_output", {
              process_id: engineId,
              reader_id: callerId,
              max_chars: boundedMaxChars,
              wait_ms: wait_ms ?? 0,
            }, extra.signal), boundedMaxChars)
          : (isBootstrapSnapshot(process_id)
            ? await readBootstrapSnapshot(boundedMaxChars, process_id, callerId, conversation_id, expected_room_head)
            : await legacyProcesses().readOutput(process_id, boundedMaxChars, wait_ms, extra.signal));
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
      const engineId = localEngineProcessId(process_id);
      const value = remoteId !== undefined
        ? remoteProcessResult(await callRemoteOmenTool("kill_process", { process_id: remoteId }, callerId))
        : engineId !== undefined
          ? localEngineKillResult(await callLocalEngineTool("kill_process", { process_id: engineId }))
          : await legacyProcesses().kill(process_id);
      return structuredTextResult(value, callerId, servingIdentity);
    },
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
