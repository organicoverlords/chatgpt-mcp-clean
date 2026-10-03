import { parentPort, Worker, workerData } from "node:worker_threads";

type LaunchData = { powershellExe: string };
type LaunchMessage = {
  type: "launch";
  requestId: string;
  command: string;
  cwd: string;
  plan?: unknown;
  ownerCallerId?: string;
  ownerSessionId?: string | null;
  stdoutSpoolPath: string;
  stderrSpoolPath: string;
};
type KillMessage = { type: "kill"; requestId: string };
type LauncherMessage = LaunchMessage | KillMessage;

const data = workerData as LaunchData;
if (!parentPort) throw new Error("process launcher worker requires a parent port");
const port = parentPort;

function workerExecArgv(source: string[] = process.execArgv): string[] {
  const result: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const arg = source[index]!;
    if (arg === "--input-type") { index += 1; continue; }
    if (arg.startsWith("--input-type=")) continue;
    result.push(arg);
  }
  return result;
}

type Session = { worker: Worker; terminalSeen: boolean };
const sessions = new Map<string, Session>();

function send(requestId: string, message: Record<string, unknown>): void {
  port.postMessage({ requestId, ...message });
}

function finishSession(requestId: string, session: Session): void {
  if (sessions.get(requestId) !== session) return;
  sessions.delete(requestId);
  void session.worker.terminate().catch(() => undefined);
}

function startSession(message: LaunchMessage): void {
  if (sessions.has(message.requestId)) {
    send(message.requestId, { type: "error", error: "duplicate launcher request: " + message.requestId });
    return;
  }
  let worker: Worker;
  try {
    worker = new Worker(new URL("./process-launch-session-worker.js", import.meta.url), {
      workerData: data,
      execArgv: workerExecArgv(),
    });
  } catch (error) {
    send(message.requestId, { type: "error", error: "process launch session unavailable: " + (error instanceof Error ? error.message : String(error)) });
    return;
  }
  const session: Session = { worker, terminalSeen: false };
  sessions.set(message.requestId, session);
  worker.on("message", (reply: any) => {
    if (!reply || typeof reply !== "object") return;
    send(message.requestId, reply);
    if (reply.type === "exit" || reply.type === "error") {
      session.terminalSeen = true;
      const timer = setTimeout(() => finishSession(message.requestId, session), 1000);
      timer.unref();
    }
  });
  worker.once("error", (error: Error) => {
    if (!session.terminalSeen) {
      session.terminalSeen = true;
      send(message.requestId, { type: "error", error: "process launch session failed: " + error.message });
    }
    finishSession(message.requestId, session);
  });
  worker.once("exit", (code) => {
    if (!session.terminalSeen) {
      session.terminalSeen = true;
      send(message.requestId, { type: "error", error: "process launch session exited with code " + code });
    }
    finishSession(message.requestId, session);
  });
  worker.postMessage(message);
}

port.on("message", (message: LauncherMessage) => {
  if (!message || typeof message !== "object" || typeof message.requestId !== "string") return;
  if (message.type === "launch") {
    startSession(message);
    return;
  }
  sessions.get(message.requestId)?.worker.postMessage(message);
});
