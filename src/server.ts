import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BusyStore } from "./lib/busy-store.js";
import { ProcessManager } from "./lib/process-manager.js";

const processManager = new ProcessManager();
const liveSessions = new Set<string>();
const busyStore = new BusyStore((scope) => {
  const sessionId = scope.startsWith("session:") ? scope.slice("session:".length) : scope;
  return liveSessions.has(sessionId) || processManager.hasLiveScope(scope);
});

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function markSessionLive(sessionId: string, live: boolean): void {
  if (live) liveSessions.add(sessionId);
  else liveSessions.delete(sessionId);
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "shell-mcp", version: "0.1.0" });

  server.registerTool(
    "execute_command",
    {
      description: "Run a PowerShell command in the foreground and return stdout, stderr, and exit code.",
      inputSchema: {
        command: z.string().min(1),
        working_directory: z.string().optional(),
        timeout_seconds: z.number().int().min(1).max(600).optional(),
      },
    },
    async ({ command, working_directory, timeout_seconds }) => textResult(await processManager.execute(command, working_directory, timeout_seconds)),
  );

  server.registerTool(
    "start_process",
    {
      description: "Start a noninteractive PowerShell process in the background and return immediately with a stable process_id.",
      inputSchema: {
        command: z.string().min(1),
        working_directory: z.string().optional(),
      },
    },
    async ({ command, working_directory }) => textResult(processManager.start(command, working_directory)),
  );

  server.registerTool(
    "read_output",
    {
      description: "Read accumulated stdout and stderr for a background process without waiting for it to finish.",
      inputSchema: {
        process_id: z.string().min(1),
        max_chars: z.number().int().min(1).max(4_000_000).optional(),
      },
    },
    async ({ process_id, max_chars }) => textResult(processManager.read(process_id, max_chars)),
  );

  server.registerTool(
    "kill_process",
    {
      description: "Terminate a background process and its entire Windows process tree.",
      inputSchema: { process_id: z.string().min(1) },
    },
    async ({ process_id }) => textResult(await processManager.kill(process_id)),
  );

  server.registerTool(
    "busy_list",
    {
      description: "List current exact-scope BUSY claims.",
      // Explicit empty shape, not an omitted inputSchema. Omitting it makes the SDK
      // advertise {"type":"object","properties":{}} with no $schema dialect, unlike
      // every other tool here; strict clients reject that tool on first call.
      inputSchema: {},
    },
    async () => textResult({ claims: busyStore.list() }),
  );

  server.registerTool(
    "busy_claim",
    {
      description: "Claim one exact scope for an actor, or report the existing claim without changing it.",
      inputSchema: { actor: z.string().min(1), scope: z.string().min(1) },
    },
    async ({ actor, scope }) => textResult(busyStore.claim(actor, scope)),
  );

  server.registerTool(
    "busy_release",
    {
      description: "Release only the named actor's claim for one exact scope.",
      inputSchema: { actor: z.string().min(1), scope: z.string().min(1) },
    },
    async ({ actor, scope }) => textResult(busyStore.release(actor, scope)),
  );

  return server;
}
