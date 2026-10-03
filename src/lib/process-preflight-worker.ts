import { parentPort } from "node:worker_threads";
import { commandExecutionPreflightError, commandPolicyError } from "./process-manager.js";
import type { CommandExecutionPlan } from "./command-execution-plan.js";

type Work = { requestId: string; command: string; mode: "full" | "policy"; executionPlan: CommandExecutionPlan };
const port = parentPort;
if (!port) throw new Error("process preflight worker requires a parent port");

port.on("message", (work: Work) => {
  if (!work || typeof work.requestId !== "string") return;
  const testDelay = Math.max(0, Number(process.env.MCP_TEST_PREFLIGHT_DELAY_MS || 0));
  if (testDelay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, testDelay);
  try {
    const error = work.mode === "policy"
      ? commandPolicyError(work.command)
      : commandExecutionPreflightError(work.command, work.executionPlan);
    port.postMessage({ requestId: work.requestId, error: error ?? null });
  } catch (error) {
    port.postMessage({
      requestId: work.requestId,
      workerError: error instanceof Error ? error.message : String(error),
    });
  }
});
