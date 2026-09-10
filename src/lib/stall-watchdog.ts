import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

type RuntimeIdentity = {
  instance_id?: string | null;
  source_commit?: string | null;
};

export type StallWatchdogOptions = {
  transportLogPath: string;
  logPath?: string;
  serverPid?: number;
  backendGeneration?: string | null;
  runtimeIdentity?: RuntimeIdentity;
  heartbeatMs?: number;
  stallThresholdMs?: number;
  sampleIntervalMs?: number;
  maxBytes?: number;
  getActiveRequests?: () => number;
  getTotalRequests?: () => number;
  onError?: (error: Error) => void;
};

export type StallWatchdogController = {
  logPath: string;
  close: () => Promise<void>;
};

const DEFAULT_HEARTBEAT_MS = 250;
const DEFAULT_STALL_THRESHOLD_MS = 1_500;
const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function boundedInteger(name: string, value: number, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

export function startStallWatchdog(options: StallWatchdogOptions): StallWatchdogController {
  const heartbeatMs = boundedInteger("heartbeatMs", options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, 10);
  const stallThresholdMs = boundedInteger("stallThresholdMs", options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS, heartbeatMs * 2);
  const sampleIntervalMs = boundedInteger("sampleIntervalMs", options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS, heartbeatMs);
  const maxBytes = boundedInteger("maxBytes", options.maxBytes ?? DEFAULT_MAX_BYTES, 1024);
  const transportLogPath = resolve(options.transportLogPath);
  const logPath = resolve(options.logPath ?? join(dirname(transportLogPath), "stall-watchdog.jsonl"));
  const worker = new Worker(new URL("./stall-watchdog-worker.js", import.meta.url), {
    workerData: {
      logPath,
      serverPid: options.serverPid ?? process.pid,
      backendGeneration: options.backendGeneration ?? null,
      runtimeInstanceId: options.runtimeIdentity?.instance_id ?? null,
      runtimeSourceCommit: options.runtimeIdentity?.source_commit ?? null,
      tickMs: heartbeatMs,
      stallThresholdMs,
      sampleIntervalMs,
      maxBytes,
    },
  });
  worker.unref();

  const onError = options.onError ?? (() => undefined);
  worker.on("error", onError);
  let sequence = 0;
  let closed = false;

  const heartbeat = () => {
    if (closed) return;
    sequence += 1;
    try {
      worker.postMessage({
        type: "heartbeat",
        sequence,
        activeRequests: options.getActiveRequests?.() ?? 0,
        totalRequests: options.getTotalRequests?.() ?? 0,
      });
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };

  heartbeat();
  const timer = setInterval(heartbeat, heartbeatMs);
  timer.unref();

  return {
    logPath,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      const exited = new Promise<void>((resolveExit) => worker.once("exit", () => resolveExit()));
      try { worker.postMessage({ type: "stop" }); } catch {}
      await Promise.race([
        exited,
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 500)),
      ]);
      if (worker.threadId !== -1) await worker.terminate();
    },
  };
}
