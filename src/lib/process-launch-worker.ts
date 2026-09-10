import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { parentPort, workerData } from "node:worker_threads";
import { processChildEnvironment } from "./process-child-environment.js";

type LaunchData = { powershellExe: string };
type LaunchMessage = { type: "launch"; requestId: string; command: string; cwd: string };
type KillMessage = { type: "kill"; requestId: string };
type LauncherMessage = LaunchMessage | KillMessage;
type OutputKind = "stdout" | "stderr";
type PendingOutput = { stdout: string; stderr: string; timer?: ReturnType<typeof setTimeout> };

const OUTPUT_FLUSH_INTERVAL_MS = 50;
// ProcessManager retains at most 100k characters per stream. Cap each queued worker
// batch at the same tail size so a producer can never build an unbounded MessagePort
// backlog for data the manager would discard anyway.
const OUTPUT_BATCH_MAX_CHARS = 100_000;

const data = workerData as LaunchData;
const port = parentPort;
if (!port) throw new Error("process launcher worker requires a parent port");

const children = new Map<string, ChildProcessByStdio<null, Readable, Readable>>();
const pendingKills = new Set<string>();
const pendingOutput = new Map<string, PendingOutput>();
const send = (requestId: string, message: Record<string, unknown>) => port.postMessage({ requestId, ...message });

function flushOutput(requestId: string): void {
  const pending = pendingOutput.get(requestId);
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pendingOutput.delete(requestId);
  if (pending.stdout) send(requestId, { type: "stdout", data: pending.stdout });
  if (pending.stderr) send(requestId, { type: "stderr", data: pending.stderr });
}

function queueOutput(requestId: string, kind: OutputKind, chunk: Buffer | string): void {
  if (!children.has(requestId)) return;
  let pending = pendingOutput.get(requestId);
  if (!pending) {
    pending = { stdout: "", stderr: "" };
    pendingOutput.set(requestId, pending);
  }
  const combined = pending[kind] + chunk.toString();
  pending[kind] = combined.length > OUTPUT_BATCH_MAX_CHARS
    ? combined.slice(-OUTPUT_BATCH_MAX_CHARS)
    : combined;
  if (!pending.timer) {
    const timer = setTimeout(() => flushOutput(requestId), OUTPUT_FLUSH_INTERVAL_MS);
    timer.unref();
    pending.timer = timer;
  }
}

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
    const child = spawn(data.powershellExe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", command], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: processChildEnvironment(),
    });
    if (!child.pid) throw new Error("Background process did not receive a PID");
    children.set(requestId, child);
    send(requestId, { type: "started", pid: child.pid });
    if (pendingKills.has(requestId)) requestKill(requestId);
    child.stdout.on("data", (chunk) => queueOutput(requestId, "stdout", chunk));
    child.stderr.on("data", (chunk) => queueOutput(requestId, "stderr", chunk));

    let terminal = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (terminal) return;
      terminal = true;
      // Flush output already delivered before publishing terminal state.
      // Keep owned-PID `exit`: descendants may inherit stdio and must not delay completion.
      flushOutput(requestId);
      children.delete(requestId);
      pendingKills.delete(requestId);
      send(requestId, { type: "exit", code: code ?? -1, signal });
    };
    child.once("error", (error) => {
      flushOutput(requestId);
      send(requestId, { type: "error", error: error.message });
      finish(-1, null);
    });
    child.once("exit", finish);
  } catch (error) {
    pendingOutput.delete(requestId);
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
