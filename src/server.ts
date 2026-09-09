import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "node:path";
import { z } from "zod";
import { BusyStore } from "./lib/busy-store.js";
import { viewImage } from "./lib/image-viewer.js";
import { ProcessManager } from "./lib/process-manager.js";
import { PROCESS_LIBRARY_UPLOAD_WIDGET_URI, processLibraryUploadContent, processLibraryUploadFromOutput, processLibraryUploadMetadata, registerProcessLibraryUploadWidget } from "./lib/process-library-upload.js";

// The deployed ChatGPT connector surface is the process profile. Keep the broader
// full profile explicit-only for internal/local tests so repo inspection without a
// deployment-specific environment cannot silently advertise non-plugin tools.
const toolProfile = (process.env.MCP_TOOL_PROFILE || "process").trim().toLowerCase();
if (toolProfile !== "full" && toolProfile !== "process") throw new Error("MCP_TOOL_PROFILE must be full or process");
const fullToolProfile = toolProfile === "full";

const processManager = new ProcessManager({
  receiptDirectory: resolve(process.env.MCP_PROCESS_RECEIPT_DIR || ".state/process-receipts"),
});
const liveSessions = new Set<string>();
const busyStore = fullToolProfile ? new BusyStore((scope) => {
  const sessionId = scope.startsWith("session:") ? scope.slice("session:".length) : scope;
  return liveSessions.has(sessionId) || processManager.hasLiveScope(scope);
}) : undefined;

async function textResult(value: unknown, id: string) {
  const data = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), caller_id: id }
    : { value, caller_id: id };
  const upload = await processLibraryUploadFromOutput(value);
  const media = upload ? processLibraryUploadContent(upload) : null;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }, ...(media ? [media] : [])],
    ...(upload ? {
      structuredContent: { library_upload_requested: true, file_name: upload.file_name, mime_type: upload.mime_type, bytes: upload.bytes },
      _meta: { chatgpt_library_upload: processLibraryUploadMetadata(upload) },
    } : {}),
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
  registerProcessLibraryUploadWidget(server);

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
      description: "Start a noninteractive PowerShell process. By default this call waits up to 750 ms so fast commands can finish and return their output in this same tool call; set wait_ms=0 for immediate background launch or raise it up to 10 seconds for a known-short command. If next_action=STOP_READING, do not call read_output. If next_action=READ_SAME_PROCESS_ID, reuse the returned process_id; never start a replacement without process evidence.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { ui: { resourceUri: PROCESS_LIBRARY_UPLOAD_WIDGET_URI }, "openai/outputTemplate": PROCESS_LIBRARY_UPLOAD_WIDGET_URI },
      inputSchema: z.object({
        command: z.string().min(1),
        working_directory: z.string().optional(),
        wait_ms: z.number().int().min(0).max(10_000).optional(),
      }),
    },
    async ({ command, working_directory, wait_ms }) => textResult(await processManager.startWithWait(command, working_directory, callerId, wait_ms ?? 750), callerId),
  );

  server.registerTool(
    "read_output",
    {
      description: "Read a bounded tail of accumulated stdout and stderr. By default this waits up to 2 seconds for new output or process exit so sparse processes do not require rapid polling; set wait_ms=0 for a genuinely nonblocking snapshot. If a positive wait expires with no change, stdout/stderr are empty and no_change=true instead of repeating old output. The returned elapsed_ms is process age, not read-call latency. A disconnect is not evidence that the process stopped; reconnect and reuse the same process_id. Each stream is limited to 32,000 characters.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: PROCESS_LIBRARY_UPLOAD_WIDGET_URI }, "openai/outputTemplate": PROCESS_LIBRARY_UPLOAD_WIDGET_URI },
      inputSchema: z.object({
        process_id: z.string().min(1),
        max_chars: z.number().int().min(1).max(32_000).optional(),
        wait_ms: z.number().int().min(0).max(10_000).optional(),
      }),
    },
    async ({ process_id, max_chars, wait_ms }) => textResult(await processManager.readWithWait(process_id, max_chars, wait_ms ?? 2_000), callerId),
  );

  server.registerTool(
    "kill_process",
    {
      description: "Terminate a background process and its entire Windows process tree.",
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      inputSchema: z.object({ process_id: z.string().min(1) }),
    },
    async ({ process_id }) => textResult(await processManager.kill(process_id), callerId),
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
