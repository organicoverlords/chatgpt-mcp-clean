import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";

type WatchdogData = {
  logPath: string;
  serverPid: number;
  backendGeneration?: string | null;
  runtimeInstanceId?: string | null;
  runtimeSourceCommit?: string | null;
  tickMs: number;
  stallThresholdMs: number;
  sampleIntervalMs: number;
  maxBytes: number;
};

type Heartbeat = {
  type: "heartbeat";
  sequence: number;
  activeRequests: number;
  totalRequests: number;
};

type Stop = { type: "stop" };
type Message = Heartbeat | Stop;

type CpuSnapshot = ReturnType<typeof cpus>;
type ResourceSnapshot = ReturnType<typeof process.resourceUsage>;

const data = workerData as WatchdogData;
const port = parentPort;
if (!port) throw new Error("stall watchdog worker requires a parent port");

let lastHeartbeatAt = performance.now();
let lastHeartbeatSequence = 0;
let lastActiveRequests = 0;
let lastTotalRequests = 0;
let lastTickAt = performance.now();
let lastSampleAt = 0;
let lastCpu = cpus();
let lastProcessCpu = process.cpuUsage();
let lastResources = process.resourceUsage();
let stallStartedAt: number | null = null;
let maxMainGapMs = 0;
let maxWatchdogDelayMs = 0;

function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function cpuTotals(snapshot: CpuSnapshot): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of snapshot) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function hostCpuPercent(previous: CpuSnapshot, current: CpuSnapshot): number | null {
  const before = cpuTotals(previous);
  const after = cpuTotals(current);
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  if (totalDelta <= 0) return null;
  return round(Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta))));
}

function resourceDelta(current: ResourceSnapshot, previous: ResourceSnapshot) {
  return {
    minor_page_fault_delta: Math.max(0, current.minorPageFault - previous.minorPageFault),
    major_page_fault_delta: Math.max(0, current.majorPageFault - previous.majorPageFault),
    fs_read_delta: Math.max(0, current.fsRead - previous.fsRead),
    fs_write_delta: Math.max(0, current.fsWrite - previous.fsWrite),
    voluntary_context_switch_delta: Math.max(0, current.voluntaryContextSwitches - previous.voluntaryContextSwitches),
    involuntary_context_switch_delta: Math.max(0, current.involuntaryContextSwitches - previous.involuntaryContextSwitches),
  };
}

function rotateIfNeeded(nextBytes: number): void {
  if (!existsSync(data.logPath)) return;
  let size = 0;
  try { size = statSync(data.logPath).size; } catch { return; }
  if (size + nextBytes <= data.maxBytes) return;
  const archiveDir = `${data.logPath}.archive`;
  mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  renameSync(data.logPath, join(archiveDir, `${basename(data.logPath)}.${stamp}.${randomUUID()}.jsonl`));
}

function write(event: Record<string, unknown>): void {
  const line = `${JSON.stringify({
    schema: "mcp-stall-watchdog.v1",
    at: new Date().toISOString(),
    server_pid: data.serverPid,
    backend_generation: data.backendGeneration ?? null,
    runtime_instance_id: data.runtimeInstanceId ?? null,
    runtime_source_commit: data.runtimeSourceCommit ?? null,
    ...event,
  })}\n`;
  mkdirSync(dirname(data.logPath), { recursive: true });
  rotateIfNeeded(Buffer.byteLength(line, "utf8"));
  appendFileSync(data.logPath, line, "utf8");
}

function sample(now: number, mainGapMs: number, watchdogTickMs: number, watchdogDelayMs: number): Record<string, unknown> {
  const currentCpu = cpus();
  const currentProcessCpu = process.cpuUsage();
  const processCpuDelta = process.cpuUsage(lastProcessCpu);
  const currentResources = process.resourceUsage();
  const elapsedMs = Math.max(1, now - lastTickAt);
  const processCpuMs = (processCpuDelta.user + processCpuDelta.system) / 1000;
  const machineCores = Math.max(1, currentCpu.length);
  const freeBytes = freemem();
  const totalBytes = totalmem();
  const memory = process.memoryUsage();
  const metrics = {
    event: "stall_sample",
    monotonic_ms: round(now, 3),
    main_heartbeat_gap_ms: round(mainGapMs),
    watchdog_tick_ms: round(watchdogTickMs),
    watchdog_tick_delay_ms: round(watchdogDelayMs),
    heartbeat_sequence: lastHeartbeatSequence,
    active_requests: lastActiveRequests,
    total_requests: lastTotalRequests,
    host_cpu_pct: hostCpuPercent(lastCpu, currentCpu),
    process_cpu_pct_one_core: round(100 * processCpuMs / elapsedMs),
    process_cpu_pct_machine: round(100 * processCpuMs / (elapsedMs * machineCores)),
    process_rss_bytes: memory.rss,
    system_total_memory_bytes: totalBytes,
    system_free_memory_bytes: freeBytes,
    system_free_memory_pct: totalBytes > 0 ? round(100 * freeBytes / totalBytes) : null,
    ...resourceDelta(currentResources, lastResources),
  };
  lastCpu = currentCpu;
  lastProcessCpu = currentProcessCpu;
  lastResources = currentResources;
  return metrics;
}

write({
  event: "watchdog_started",
  monotonic_ms: round(performance.now(), 3),
  tick_ms: data.tickMs,
  stall_threshold_ms: data.stallThresholdMs,
  sample_interval_ms: data.sampleIntervalMs,
});

const timer = setInterval(() => {
  const now = performance.now();
  const watchdogTickMs = now - lastTickAt;
  const watchdogDelayMs = Math.max(0, watchdogTickMs - data.tickMs);
  const mainGapMs = now - lastHeartbeatAt;
  const stalled = mainGapMs >= data.stallThresholdMs || watchdogDelayMs >= data.stallThresholdMs;

  maxMainGapMs = Math.max(maxMainGapMs, mainGapMs);
  maxWatchdogDelayMs = Math.max(maxWatchdogDelayMs, watchdogDelayMs);

  if (stalled) {
    if (stallStartedAt === null) {
      stallStartedAt = now;
      lastSampleAt = 0;
      write({
        ...sample(now, mainGapMs, watchdogTickMs, watchdogDelayMs),
        event: "stall_begin",
      });
    } else if (now - lastSampleAt >= data.sampleIntervalMs) {
      write(sample(now, mainGapMs, watchdogTickMs, watchdogDelayMs));
    }
    lastSampleAt = now;
  } else if (stallStartedAt !== null) {
    write({
      event: "stall_recovered",
      monotonic_ms: round(now, 3),
      observed_stall_ms: round(now - stallStartedAt),
      max_main_heartbeat_gap_ms: round(maxMainGapMs),
      max_watchdog_tick_delay_ms: round(maxWatchdogDelayMs),
      heartbeat_sequence: lastHeartbeatSequence,
      active_requests: lastActiveRequests,
      total_requests: lastTotalRequests,
    });
    stallStartedAt = null;
    maxMainGapMs = 0;
    maxWatchdogDelayMs = 0;
  }

  if (!stalled) {
    const currentCpu = cpus();
    lastCpu = currentCpu;
    lastProcessCpu = process.cpuUsage();
    lastResources = process.resourceUsage();
  }
  lastTickAt = now;
}, data.tickMs);
timer.unref();

port.on("message", (message: Message) => {
  if (message?.type === "heartbeat") {
    lastHeartbeatAt = performance.now();
    lastHeartbeatSequence = message.sequence;
    lastActiveRequests = message.activeRequests;
    lastTotalRequests = message.totalRequests;
    return;
  }
  if (message?.type === "stop") {
    clearInterval(timer);
    write({ event: "watchdog_stopped", monotonic_ms: round(performance.now(), 3) });
    port.close();
  }
});
