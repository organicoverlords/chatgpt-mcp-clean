import { spawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { processChildEnvironment } from "./process-child-environment.js";
import { planCommandExecution, type CommandExecutionPlan, type CommandExecutionStep } from "./command-execution-plan.js";

type LaunchData = { powershellExe: string };

function launchEnvironment(command: string, requestId: string, cwd: string): { env: NodeJS.ProcessEnv; pytestTempRoot?: string } {
  const env = processChildEnvironment(process.env, undefined, cwd);
  const invokesPytest = /(?:^|[;&|\s])(?:(?:python|python\.exe|py|py\.exe)\s+(?:-[^\s]+\s+)*-m\s+pytest\b|pytest(?:\.exe)?\b)/i.test(command);
  if (!invokesPytest || /--basetemp(?:=|\s)/i.test(command) || env.PYTEST_DEBUG_TEMPROOT) return { env };
  const systemTemp = (env.TEMP || env.TMP || "").trim();
  if (!systemTemp) return { env };
  const pytestTempRoot = join(systemTemp, "mcp-pytest", requestId);
  mkdirSync(pytestTempRoot, { recursive: true });
  env.PYTEST_DEBUG_TEMPROOT = pytestTempRoot;
  return { env, pytestTempRoot };
}

type LaunchMessage = { type: "launch"; requestId: string; command: string; cwd: string; plan?: CommandExecutionPlan };
type KillMessage = { type: "kill"; requestId: string };
type LauncherMessage = LaunchMessage | KillMessage;
type OutputKind = "stdout" | "stderr";
type PendingOutput = { stdout: string; stderr: string; timer?: ReturnType<typeof setTimeout> };
type StepResult = { code: number; signal: NodeJS.Signals | null };

const OUTPUT_FLUSH_INTERVAL_MS = 50;
const OUTPUT_BATCH_MAX_CHARS = 100_000;

const data = workerData as LaunchData;
const port = parentPort;
if (!port) throw new Error("process launcher worker requires a parent port");

const children = new Map<string, ChildProcess>();
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

function planSteps(plan: CommandExecutionPlan): CommandExecutionStep[] {
  if (plan.steps?.length) return plan.steps;
  return [{
    executable: plan.executable,
    args: plan.args,
    runIf: "always",
    reason: plan.reason,
    ...(plan.stdin !== undefined ? { stdin: plan.stdin } : {}),
  }];
}

function shouldRunStep(step: CommandExecutionStep, previousCode: number | undefined): boolean {
  if (step.runIf === "always" || previousCode === undefined) return true;
  if (step.runIf === "success") return previousCode === 0;
  return previousCode !== 0;
}

function runStep(
  requestId: string,
  step: CommandExecutionStep,
  cwd: string,
  env: NodeJS.ProcessEnv,
  plan: CommandExecutionPlan,
  stepIndex: number,
  stepCount: number,
): Promise<StepResult> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(step.executable, step.args, {
      cwd,
      windowsHide: true,
      stdio: [step.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      env,
    });
    if (!child.pid) {
      reject(new Error(`Background process did not receive a PID: ${step.executable}`));
      return;
    }
    children.set(requestId, child);
    const startMessage = stepIndex === 0 ? "started" : "step_started";
    send(requestId, {
      type: startMessage,
      pid: child.pid,
      executionMode: plan.mode,
      executionReason: plan.reason,
      stepIndex,
      stepCount,
      stepReason: step.reason,
    });
    if (pendingKills.has(requestId)) requestKill(requestId);
    child.stdout?.on("data", (chunk) => queueOutput(requestId, "stdout", chunk));
    child.stderr?.on("data", (chunk) => queueOutput(requestId, "stderr", chunk));
    if (step.stdin !== undefined) child.stdin?.end(step.stdin);

    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      flushOutput(requestId);
      children.delete(requestId);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      flushOutput(requestId);
      children.delete(requestId);
      resolve({ code: code ?? -1, signal });
    });
  });
}

async function executePlan(requestId: string, command: string, cwd: string, suppliedPlan?: CommandExecutionPlan): Promise<void> {
  const plan = suppliedPlan ?? planCommandExecution(command, data.powershellExe);
  const launchEnv = launchEnvironment(command, requestId, cwd);
  const steps = planSteps(plan);
  let previousCode: number | undefined;
  let finalSignal: NodeJS.Signals | null = null;
  try {
    for (let index = 0; index < steps.length; index += 1) {
      if (pendingKills.has(requestId) && previousCode !== undefined) {
        previousCode = -1;
        finalSignal = null;
        break;
      }
      const step = steps[index]!;
      if (!shouldRunStep(step, previousCode)) continue;
      const result = await runStep(requestId, step, cwd, launchEnv.env, plan, index, steps.length);
      previousCode = result.code;
      finalSignal = result.signal;
      if (result.signal) break;
    }
    send(requestId, { type: "exit", code: previousCode ?? 0, signal: finalSignal });
  } catch (error) {
    send(requestId, { type: "error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    flushOutput(requestId);
    children.delete(requestId);
    pendingKills.delete(requestId);
    if (launchEnv.pytestTempRoot) {
      try { rmSync(launchEnv.pytestTempRoot, { recursive: true, force: true }); } catch {}
    }
  }
}

function launch(requestId: string, command: string, cwd: string, suppliedPlan?: CommandExecutionPlan): void {
  const testDelay = Math.max(0, Number(process.env.MCP_TEST_LAUNCH_DELAY_MS || 0));
  if (testDelay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, testDelay);
  void executePlan(requestId, command, cwd, suppliedPlan);
}

port.on("message", (message: LauncherMessage) => {
  if (!message || typeof message !== "object" || typeof message.requestId !== "string") return;
  if (message.type === "kill") {
    requestKill(message.requestId);
    return;
  }
  if (message.type === "launch") launch(message.requestId, message.command, message.cwd, message.plan);
});
