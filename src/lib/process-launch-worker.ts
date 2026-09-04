import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { parentPort, workerData } from "node:worker_threads";

type LaunchData = { command: string; cwd: string; powershellExe: string };
const data = workerData as LaunchData;
const port = parentPort;
if (!port) throw new Error("process launcher worker requires a parent port");

const testDelay = Math.max(0, Number(process.env.MCP_TEST_LAUNCH_DELAY_MS || 0));
if (testDelay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, testDelay);

let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
let killRequested = false;
const send = (message: Record<string, unknown>) => port.postMessage(message);

const requestKill = () => {
  killRequested = true;
  if (!child?.pid) return;
  const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  const timer = setTimeout(() => killer.kill(), 2_000);
  timer.unref();
  killer.once("close", () => clearTimeout(timer));
};

port.on("message", (message) => { if (message?.type === "kill") requestKill(); });
try {
  child = spawn(data.powershellExe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", data.command], {
    cwd: data.cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (!child.pid) throw new Error("Background process did not receive a PID");

  send({ type: "started", pid: child.pid });
  if (killRequested) requestKill();
  child.stdout.on("data", (chunk) => send({ type: "stdout", data: chunk.toString() }));
  child.stderr.on("data", (chunk) => send({ type: "stderr", data: chunk.toString() }));

  let terminal = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (terminal) return;
    terminal = true;
    send({ type: "exit", code: code ?? -1, signal });
    port.close();
  };
  child.once("error", (error) => {
    send({ type: "error", error: error.message });
    finish(-1, null);
  });
  child.once("exit", finish);
} catch (error) {
  send({ type: "error", error: error instanceof Error ? error.message : String(error) });
  port.close();
}
