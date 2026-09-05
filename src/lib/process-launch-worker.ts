import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { parentPort, workerData } from "node:worker_threads";

type LaunchData = { powershellExe: string };
type LaunchMessage = { type: "launch"; requestId: string; command: string; cwd: string };
type KillMessage = { type: "kill"; requestId: string };
type LauncherMessage = LaunchMessage | KillMessage;

const data = workerData as LaunchData;
const port = parentPort;
if (!port) throw new Error("process launcher worker requires a parent port");

const children = new Map<string, ChildProcessByStdio<null, Readable, Readable>>();
const pendingKills = new Set<string>();
const send = (requestId: string, message: Record<string, unknown>) => port.postMessage({ requestId, ...message });

function requestKill(requestId: string): void {
  pendingKills.add(requestId);
  const child = children.get(requestId);
  if (!child?.pid) return;
  const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  const timer = setTimeout(() => killer.kill(), 2_000);
  timer.unref();
  killer.once("close", () => clearTimeout(timer));
}

function launch(requestId: string, command: string, cwd: string): void {
  const testDelay = Math.max(0, Number(process.env.MCP_TEST_LAUNCH_DELAY_MS || 0));
  if (testDelay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, testDelay);
  try {
    const child = spawn(data.powershellExe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    if (!child.pid) throw new Error("Background process did not receive a PID");
    children.set(requestId, child);
    send(requestId, { type: "started", pid: child.pid });
    if (pendingKills.has(requestId)) requestKill(requestId);
    child.stdout.on("data", (chunk) => send(requestId, { type: "stdout", data: chunk.toString() }));
    child.stderr.on("data", (chunk) => send(requestId, { type: "stderr", data: chunk.toString() }));

    let terminal = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (terminal) return;
      terminal = true;
      children.delete(requestId);
      pendingKills.delete(requestId);
      send(requestId, { type: "exit", code: code ?? -1, signal });
    };
    child.once("error", (error) => {
      send(requestId, { type: "error", error: error.message });
      finish(-1, null);
    });
    child.once("exit", finish);
  } catch (error) {
    pendingKills.delete(requestId);
    send(requestId, { type: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

port.on("message", (message: LauncherMessage) => {
  if (!message || typeof message !== "object" || typeof message.requestId !== "string") return;
  if (message.type === "kill") {
    requestKill(message.requestId);
    return;
  }
  if (message.type === "launch") launch(message.requestId, message.command, message.cwd);
});
