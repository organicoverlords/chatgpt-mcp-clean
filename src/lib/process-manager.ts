import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { currentTelemetryContext, emitTelemetry, withTelemetryContext, type TelemetryContext } from "./transport-telemetry.js";

const MAX_CAPTURE_CHARS = 100_000;
// Keep one read large enough for the current ChatGPT bootstrap plus its compact recent-memory
// glance. The old 6,000-character ceiling was a defensive workaround for an Aug 25 transport
// hypothesis that later evidence rejected as a universal payload wall. 32,000 is deliberately
// below the 100,000-character capture ceiling; caller-side delivery still requires a live canary.
const MAX_READ_CHARS = 32_000;
const MAX_COMMAND_REPORT_CHARS = 4_000;
const COMPLETED_RETENTION_MS = 30 * 60 * 1000;
const MAX_COMPLETED_PROCESSES = 64;
const TASKKILL_TIMEOUT_MS = 2_000;
const KILL_SETTLE_MS = 1_000;
const DEFAULT_LAUNCH_BUCKET_CAPACITY = 40;
const DEFAULT_LAUNCH_REFILL_MS = 5_000;
const DEFAULT_MAX_LIVE_PER_CALLER = 3;
const CONTROL_POLL_MS = 100;
const CONTROL_HANDOFF_OVERHEAD_MS = 1_500;
const CONTROL_KILL_TIMEOUT_MS = TASKKILL_TIMEOUT_MS + KILL_SETTLE_MS + CONTROL_HANDOFF_OVERHEAD_MS;
const CONTROL_RETENTION_MS = COMPLETED_RETENTION_MS;
const CONTROL_PRUNE_INTERVAL_MS = 60_000;
type CapturedChild = ChildProcessByStdio<null, Readable, Readable>;

type ProcessManagerOptions = {
  maxLaunchesPerWindow?: number;
  launchRefillMs?: number;
  maxLivePerCaller?: number;
  now?: () => number;
  receiptDirectory?: string;
};

type LaunchBucket = {
  tokens: number;
  lastRefillAt: number;
};

type CompletedProcessReceipt = {
  version: 1;
  process_id: string;
  pid: number;
  caller_id: string;
  command: string;
  command_truncated?: true;
  cwd: string;
  stdout: string;
  stderr: string;
  stdout_truncated?: true;
  stderr_truncated?: true;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  started_at: string;
  finished_at: string;
  error?: string;
};

type ProcessControlRequest = {
  version: 1;
  request_id: string;
  process_id: string;
  action: "read" | "kill";
  requester_caller_id: string;
  requested_at: string;
  deadline_at: string;
  max_chars?: number;
  wait_ms?: number;
};

type ProcessControlResponse = {
  version: 1;
  request_id: string;
  process_id: string;
  responded_at: string;
  result?: Record<string, unknown>;
  error?: string;
};

const PROCESS_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class BoundedCapture {
  private readonly chunks: string[] = [];
  private length = 0;
  truncated = false;

  append(chunk: Buffer | string): void {
    let text = chunk.toString();
    if (!text) return;
    if (text.length >= MAX_CAPTURE_CHARS) {
      text = text.slice(-MAX_CAPTURE_CHARS);
      this.chunks.length = 0;
      this.chunks.push(text);
      this.length = text.length;
      this.truncated = true;
      return;
    }
    this.chunks.push(text);
    this.length += text.length;
    while (this.length > MAX_CAPTURE_CHARS) {
      const overflow = this.length - MAX_CAPTURE_CHARS;
      const first = this.chunks[0]!;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.length -= first.length;
      } else {
        this.chunks[0] = first.slice(overflow);
        this.length -= overflow;
      }
      this.truncated = true;
    }
  }

  // ceiling defaults to the transport cap. Receipts pass MAX_CAPTURE_CHARS because they
  // are written to disk, never sent over MCP, and are the only durable proof of what a
  // process produced when the caller's read is blocked or truncated.
  tail(maxChars: number, ceiling: number = MAX_READ_CHARS): { text: string; truncated: boolean; dropped: number } {
    let remaining = Math.max(1, Math.min(maxChars, ceiling));
    const parts: string[] = [];
    for (let index = this.chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const chunk = this.chunks[index]!;
      const part = chunk.length <= remaining ? chunk : chunk.slice(-remaining);
      parts.push(part);
      remaining -= part.length;
    }
    const text = parts.reverse().join("");
    // dropped counts the characters cut from the START, because this returns the tail.
    // A caller that asked for the first N lines of a file gets the last slice of that
    // output, so a bare boolean is not enough to notice the beginning is missing.
    const dropped = Math.max(0, this.length - text.length);
    return { text, truncated: this.truncated || this.length > maxChars, dropped };
  }
}

type ProcessState = {
  id: string;
  pid: number;
  callerId: string;
  ownerContext: TelemetryContext;
  command: string;
  cwd: string;
  child: CapturedChild;
  stdout: BoundedCapture;
  stderr: BoundedCapture;
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  done: Promise<void>;
  revision: number;
  lastReadRevisionByCaller: Map<string, number>;
  waiters: Set<() => void>;
};

// Absolute path so a mangled PATH in an inherited environment cannot turn into a
// spawn failure. Falls back to bare resolution only if SystemRoot is unset.
const POWERSHELL_EXE = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : "powershell.exe";

// spawn() reports ENOENT when the *cwd* does not exist, and node attributes it to the
// executable -- "spawn powershell.exe ENOENT" for a bad working_directory sends callers
// hunting a PATH problem that does not exist. Validate the directory up front and fail
// with a message that names the real cause.
function normalizedCwd(workingDirectory?: string): string {
  if (!workingDirectory) return process.cwd();
  if (!isAbsolute(workingDirectory)) {
    throw new Error(`working_directory must be an absolute path, received "${workingDirectory}"`);
  }
  const resolved = resolve(workingDirectory);
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error(`working_directory does not exist: "${resolved}"`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`working_directory is not a directory: "${resolved}"`);
  }
  return resolved;
}

function powershell(command: string, cwd: string): CapturedChild {
  return spawn(
    POWERSHELL_EXE,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );
}

async function taskkillTree(pid: number): Promise<{ code: number; timedOut: boolean }> {
  return await new Promise<{ code: number; timedOut: boolean }>((resolve, reject) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    let settled = false;
    const finish = (result: { code: number; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killer.kill();
      finish({ code: 124, timedOut: true });
    }, TASKKILL_TIMEOUT_MS);
    killer.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    killer.once("close", (code) => finish({ code: code ?? 1, timedOut: false }));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processResponseState(startedAt: string, running: boolean, finishedAt?: string | null): {
  mcp_status: "OK";
  process_state: "RUNNING" | "COMPLETED";
  elapsed_ms: number;
  next_action: "READ_SAME_PROCESS_ID" | "STOP_READING";
} {
  const endMs = running ? Date.now() : Date.parse(finishedAt ?? startedAt);
  return {
    mcp_status: "OK",
    process_state: running ? "RUNNING" : "COMPLETED",
    elapsed_ms: Math.max(0, endMs - Date.parse(startedAt)),
    next_action: running ? "READ_SAME_PROCESS_ID" : "STOP_READING",
  };
}

export class ProcessManager {
  private readonly processes = new Map<string, ProcessState>();
  private readonly launchBucketsByCaller = new Map<string, LaunchBucket>();
  private readonly launchBucketCapacity: number;
  private readonly launchRefillMs: number;
  private readonly maxLivePerCaller: number;
  private readonly now: () => number;
  private readonly receiptDirectory?: string;
  private readonly controlRequestDirectory?: string;
  private readonly controlResponseDirectory?: string;
  private readonly controlRequestsInFlight = new Set<string>();
  private lastControlPruneAt = 0;

  constructor(options: ProcessManagerOptions = {}) {
    this.launchBucketCapacity = options.maxLaunchesPerWindow ?? DEFAULT_LAUNCH_BUCKET_CAPACITY;
    this.launchRefillMs = options.launchRefillMs ?? DEFAULT_LAUNCH_REFILL_MS;
    this.maxLivePerCaller = options.maxLivePerCaller ?? DEFAULT_MAX_LIVE_PER_CALLER;
    this.now = options.now ?? Date.now;
    this.receiptDirectory = options.receiptDirectory ? resolve(options.receiptDirectory) : undefined;
    if (this.receiptDirectory) {
      mkdirSync(this.receiptDirectory, { recursive: true });
      this.controlRequestDirectory = join(this.receiptDirectory, ".control", "requests");
      this.controlResponseDirectory = join(this.receiptDirectory, ".control", "responses");
      mkdirSync(this.controlRequestDirectory, { recursive: true });
      mkdirSync(this.controlResponseDirectory, { recursive: true });
      this.pruneReceipts();
      this.pruneControlFiles();
      const controlTimer = setInterval(() => this.sweepControlRequests(), CONTROL_POLL_MS);
      controlTimer.unref();
    }
  }

  private receiptPath(processId: string): string | undefined {
    if (!this.receiptDirectory || !PROCESS_ID_PATTERN.test(processId)) return undefined;
    return join(this.receiptDirectory, `${processId}.json`);
  }

  private pruneReceipts(): void {
    if (!this.receiptDirectory) return;
    const now = Date.now();
    const files = readdirSync(this.receiptDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && PROCESS_ID_PATTERN.test(entry.name.slice(0, -5)) && entry.name.endsWith(".json"))
      .map((entry) => {
        const path = join(this.receiptDirectory!, entry.name);
        return { path, modifiedAt: statSync(path).mtimeMs };
      })
      .sort((a, b) => a.modifiedAt - b.modifiedAt);
    for (const file of files) {
      if (now - file.modifiedAt > COMPLETED_RETENTION_MS) unlinkSync(file.path);
    }
    const retained = files.filter((file) => now - file.modifiedAt <= COMPLETED_RETENTION_MS);
    for (const file of retained.slice(0, Math.max(0, retained.length - MAX_COMPLETED_PROCESSES))) unlinkSync(file.path);
  }

  private controlPath(directory: string | undefined, requestId: string): string | undefined {
    if (!directory || !PROCESS_ID_PATTERN.test(requestId)) return undefined;
    return join(directory, `${requestId}.json`);
  }

  private writeControlFile(path: string, value: ProcessControlRequest | ProcessControlResponse): void {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
      renameSync(temporaryPath, path);
    } finally {
      try { unlinkSync(temporaryPath); } catch { /* already renamed or never created */ }
    }
  }

  private pruneControlFiles(): void {
    const now = Date.now();
    if (now - this.lastControlPruneAt < CONTROL_PRUNE_INTERVAL_MS) return;
    this.lastControlPruneAt = now;
    const cutoff = now - CONTROL_RETENTION_MS;
    for (const directory of [this.controlRequestDirectory, this.controlResponseDirectory]) {
      if (!directory) continue;
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const path = join(directory, entry.name);
        try {
          if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
        } catch { /* best-effort cleanup */ }
      }
    }
  }

  private sweepControlRequests(): void {
    if (!this.controlRequestDirectory || !this.controlResponseDirectory) return;
    this.pruneControlFiles();
    let entries;
    try {
      entries = readdirSync(this.controlRequestDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const requestPath = join(this.controlRequestDirectory, entry.name);
      let request: ProcessControlRequest;
      try {
        request = JSON.parse(readFileSync(requestPath, "utf8")) as ProcessControlRequest;
      } catch {
        continue;
      }
      if (
        request.version !== 1 ||
        !PROCESS_ID_PATTERN.test(request.request_id) ||
        !PROCESS_ID_PATTERN.test(request.process_id) ||
        (request.action !== "read" && request.action !== "kill") ||
        typeof request.requester_caller_id !== "string" ||
        !Number.isFinite(Date.parse(request.deadline_at))
      ) {
        try { unlinkSync(requestPath); } catch { /* best effort */ }
        continue;
      }
      if (Date.now() > Date.parse(request.deadline_at)) {
        try { unlinkSync(requestPath); } catch { /* best effort */ }
        continue;
      }
      if (!this.processes.has(request.process_id) || this.controlRequestsInFlight.has(request.request_id)) continue;
      this.controlRequestsInFlight.add(request.request_id);
      void this.handleControlRequest(request, requestPath).finally(() => {
        this.controlRequestsInFlight.delete(request.request_id);
      });
    }
  }

  private async handleControlRequest(request: ProcessControlRequest, requestPath: string): Promise<void> {
    const responsePath = this.controlPath(this.controlResponseDirectory, request.request_id);
    if (!responsePath) return;
    const observer: TelemetryContext = {
      request_id: request.request_id,
      caller_id: request.requester_caller_id,
    };
    const response: ProcessControlResponse = {
      version: 1,
      request_id: request.request_id,
      process_id: request.process_id,
      responded_at: new Date().toISOString(),
    };
    try {
      response.result = await withTelemetryContext(observer, async () => request.action === "kill"
        ? await this.kill(request.process_id)
        : await this.readWithWait(request.process_id, request.max_chars, request.wait_ms));
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error);
    }
    response.responded_at = new Date().toISOString();
    try {
      this.writeControlFile(responsePath, response);
    } finally {
      try { unlinkSync(requestPath); } catch { /* requester may have timed out */ }
    }
  }

  private async requestRemoteControl(
    processId: string,
    action: "read" | "kill",
    observer: TelemetryContext,
    maxChars = MAX_READ_CHARS,
    waitMs = 0,
  ): Promise<Record<string, unknown>> {
    if (!this.controlRequestDirectory || !this.controlResponseDirectory || !PROCESS_ID_PATTERN.test(processId)) {
      throw new Error(`Unknown process_id: ${processId}`);
    }
    const requestId = randomUUID();
    const boundedWaitMs = Math.max(0, Math.min(waitMs, 10_000));
    const timeoutMs = action === "read"
      ? boundedWaitMs + CONTROL_HANDOFF_OVERHEAD_MS
      : CONTROL_KILL_TIMEOUT_MS;
    const deadlineMs = Date.now() + timeoutMs;
    const requestPath = this.controlPath(this.controlRequestDirectory, requestId)!;
    const responsePath = this.controlPath(this.controlResponseDirectory, requestId)!;
    const request: ProcessControlRequest = {
      version: 1,
      request_id: requestId,
      process_id: processId,
      action,
      requester_caller_id: observer.caller_id ?? "caller_unknown",
      requested_at: new Date().toISOString(),
      deadline_at: new Date(deadlineMs).toISOString(),
      ...(action === "read" ? { max_chars: Math.max(1, Math.min(maxChars, MAX_READ_CHARS)), wait_ms: boundedWaitMs } : {}),
    };
    this.writeControlFile(requestPath, request);
    emitTelemetry({
      event: "process_control_handoff_requested",
      process_id: processId,
      action,
      request_id: requestId,
    }, observer);
    try {
      while (Date.now() <= deadlineMs) {
        try {
          const response = JSON.parse(readFileSync(responsePath, "utf8")) as ProcessControlResponse;
          if (response.version !== 1 || response.request_id !== requestId || response.process_id !== processId) {
            throw new Error(`Invalid process control response for ${processId}`);
          }
          if (response.error) throw new Error(response.error);
          if (!response.result || typeof response.result !== "object") throw new Error(`Empty process control response for ${processId}`);
          emitTelemetry({
            event: "process_control_handoff_completed",
            process_id: processId,
            action,
            request_id: requestId,
          }, observer);
          return response.result;
        } catch (error) {
          const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
          if (code !== "ENOENT") throw error;
        }
        if (action === "read") {
          const receipt = this.readReceipt(processId, maxChars);
          if (receipt) return receipt;
        }
        await delay(CONTROL_POLL_MS);
      }
      emitTelemetry({
        event: "process_control_handoff_timeout",
        process_id: processId,
        action,
        request_id: requestId,
      }, observer);
      throw new Error(`Process owner unavailable for process_id: ${processId}`);
    } finally {
      try { unlinkSync(requestPath); } catch { /* owner may already have consumed it */ }
      try { unlinkSync(responsePath); } catch { /* response may not exist */ }
    }
  }

  private persistReceipt(state: ProcessState): void {
    const path = this.receiptPath(state.id);
    if (!path || !state.finishedAt) return;
    const command = state.command.slice(0, MAX_COMMAND_REPORT_CHARS);
    // Receipts are local evidence, not a transport payload, so they keep the full
    // captured buffer. Using MAX_READ_CHARS here would shrink the durable record to the
    // transport ceiling and destroy the only proof that a blocked read's process ran.
    const stdout = state.stdout.tail(MAX_CAPTURE_CHARS, MAX_CAPTURE_CHARS);
    const stderr = state.stderr.tail(MAX_CAPTURE_CHARS, MAX_CAPTURE_CHARS);
    const receipt: CompletedProcessReceipt = {
      version: 1,
      process_id: state.id,
      pid: state.pid,
      caller_id: state.callerId,
      command,
      ...(state.command.length > MAX_COMMAND_REPORT_CHARS ? { command_truncated: true as const } : {}),
      cwd: state.cwd,
      stdout: stdout.text,
      stderr: stderr.text,
      ...(stdout.truncated ? { stdout_truncated: true as const } : {}),
      ...(stderr.truncated ? { stderr_truncated: true as const } : {}),
      exit_code: state.exitCode,
      signal: state.signal ?? null,
      started_at: state.startedAt,
      finished_at: state.finishedAt,
      ...(state.error ? { error: state.error } : {}),
    };
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(receipt), { encoding: "utf8", flag: "wx" });
      renameSync(temporaryPath, path);
      this.pruneReceipts();
      emitTelemetry({
        event: "process_receipt_persisted",
        process_id: state.id,
        pid: state.pid,
        owner_caller_id: state.callerId,
      }, state.ownerContext);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* best-effort temporary cleanup */ }
      emitTelemetry({
        event: "process_receipt_error",
        process_id: state.id,
        pid: state.pid,
        owner_caller_id: state.callerId,
        error_message: error instanceof Error ? error.message : String(error),
      }, state.ownerContext);
    }
  }

  private readReceipt(processId: string, maxChars: number): Record<string, unknown> | undefined {
    const path = this.receiptPath(processId);
    if (!path) return undefined;
    this.pruneReceipts();
    let receipt: CompletedProcessReceipt;
    try {
      receipt = JSON.parse(readFileSync(path, "utf8")) as CompletedProcessReceipt;
    } catch {
      return undefined;
    }
    if (receipt.version !== 1 || receipt.process_id !== processId || typeof receipt.pid !== "number" || typeof receipt.command !== "string" || typeof receipt.cwd !== "string" || typeof receipt.stdout !== "string" || typeof receipt.stderr !== "string" || typeof receipt.started_at !== "string" || typeof receipt.finished_at !== "string") {
      return undefined;
    }
    const limit = Math.max(1, Math.min(maxChars, MAX_READ_CHARS));
    const stdout = receipt.stdout.slice(-limit);
    const stderr = receipt.stderr.slice(-limit);
    const observer = currentTelemetryContext();
    emitTelemetry({
      event: "process_receipt_read",
      process_id: receipt.process_id,
      pid: receipt.pid,
      owner_caller_id: receipt.caller_id,
      caller_id: observer.caller_id ?? "caller_unknown",
    }, observer);
    return {
      ...processResponseState(receipt.started_at, false, receipt.finished_at),
      process_id: receipt.process_id,
      pid: receipt.pid,
      command: receipt.command,
      ...(receipt.command_truncated ? { command_truncated: true } : {}),
      cwd: receipt.cwd,
      running: false,
      stdout,
      stderr,
      exit_code: receipt.exit_code,
      signal: receipt.signal,
      started_at: receipt.started_at,
      finished_at: receipt.finished_at,
      ...(receipt.stdout_truncated || receipt.stdout.length > limit ? { stdout_truncated: true } : {}),
      ...(receipt.stderr_truncated || receipt.stderr.length > limit ? { stderr_truncated: true } : {}),
      ...(receipt.error ? { error: receipt.error } : {}),
    };
  }

  private reserveLaunch(callerId: string): void {
    const now = this.now();
    const bucket = this.launchBucketsByCaller.get(callerId) ?? {
      tokens: this.launchBucketCapacity,
      lastRefillAt: now,
    };
    const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
    bucket.tokens = Math.min(
      this.launchBucketCapacity,
      bucket.tokens + elapsedMs / this.launchRefillMs,
    );
    bucket.lastRefillAt = now;
    if (bucket.tokens < 1) {
      const retryAfterMs = Math.max(1, Math.ceil((1 - bucket.tokens) * this.launchRefillMs));
      this.launchBucketsByCaller.set(callerId, bucket);
      throw new Error(`start_process_rate_limited: caller launch bucket is empty; capacity=${this.launchBucketCapacity}; refill_ms=${this.launchRefillMs}; retry_after_ms=${retryAfterMs}`);
    }
    bucket.tokens -= 1;
    this.launchBucketsByCaller.set(callerId, bucket);
  }

  private markProcessChanged(state: ProcessState): void {
    state.revision += 1;
    for (const wake of [...state.waiters]) wake();
  }

  private pruneCompleted(): void {
    const now = Date.now();
    const completed = [...this.processes.values()]
      .filter((state) => state.exitCode !== null && state.finishedAt)
      .sort((a, b) => Date.parse(a.finishedAt!) - Date.parse(b.finishedAt!));
    for (const state of completed) {
      const expired = now - Date.parse(state.finishedAt!) > COMPLETED_RETENTION_MS;
      if (expired) this.processes.delete(state.id);
    }
    const remaining = [...this.processes.values()]
      .filter((state) => state.exitCode !== null && state.finishedAt)
      .sort((a, b) => Date.parse(a.finishedAt!) - Date.parse(b.finishedAt!));
    for (const state of remaining.slice(0, Math.max(0, remaining.length - MAX_COMPLETED_PROCESSES))) this.processes.delete(state.id);
  }

  start(command: string, workingDirectory?: string, callerId = "caller_unknown"): { mcp_status: "OK"; process_state: "RUNNING" | "COMPLETED"; elapsed_ms: number; next_action: "READ_SAME_PROCESS_ID" | "STOP_READING"; process_id: string; pid: number; cwd: string; running: boolean } {
    this.pruneCompleted();
    const cwd = normalizedCwd(workingDirectory);
    const duplicate = [...this.processes.values()].find((state) =>
      state.exitCode === null && state.callerId === callerId && state.cwd === cwd && state.command === command
    );
    if (duplicate) {
      emitTelemetry({
        event: "process_reused",
        process_id: duplicate.id,
        pid: duplicate.pid,
        owner_caller_id: duplicate.callerId,
      });
      return { ...processResponseState(duplicate.startedAt, true), process_id: duplicate.id, pid: duplicate.pid, cwd: duplicate.cwd, running: true } as const;
    }
    const liveForCaller = [...this.processes.values()].filter((state) => state.exitCode === null && state.callerId === callerId);
    if (liveForCaller.length >= this.maxLivePerCaller) {
      throw new Error(`start_process_concurrency_limited: caller already has ${liveForCaller.length} live processes; active_process_ids=${liveForCaller.map((state) => state.id).join(",")}`);
    }
    this.reserveLaunch(callerId);
    const child = powershell(command, cwd);
    if (!child.pid) throw new Error("Background process did not receive a PID");

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const ownerContext = currentTelemetryContext();
    const state: ProcessState = {
      id: randomUUID(),
      pid: child.pid,
      callerId,
      ownerContext,
      command,
      cwd,
      child,
      stdout: new BoundedCapture(),
      stderr: new BoundedCapture(),
      startedAt: new Date().toISOString(),
      exitCode: null,
      done,
      revision: 0,
      lastReadRevisionByCaller: new Map<string, number>(),
      waiters: new Set<() => void>(),
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      state.stdout.append(chunk);
      this.markProcessChanged(state);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      state.stderr.append(chunk);
      this.markProcessChanged(state);
    });
    child.once("error", (error) => {
      state.error = error.message;
      if (state.exitCode === null) state.exitCode = -1;
      this.markProcessChanged(state);
      emitTelemetry({
        event: "process_error",
        process_id: state.id,
        pid: state.pid,
        owner_caller_id: state.callerId,
        error_code: "code" in error ? error.code : null,
        error_message: error.message,
      }, state.ownerContext);
    });
    child.once("close", (code, signal) => {
      if (state.exitCode === null) state.exitCode = code;
      state.signal = signal;
      state.finishedAt = new Date().toISOString();
      this.markProcessChanged(state);
      this.persistReceipt(state);
      emitTelemetry({
        event: "process_exit_observed",
        process_id: state.id,
        pid: state.pid,
        owner_caller_id: state.callerId,
        exit_code: state.exitCode,
        signal: state.signal ?? null,
        started_at: state.startedAt,
        finished_at: state.finishedAt,
      }, state.ownerContext);
      resolveDone();
    });
    this.processes.set(state.id, state);
    emitTelemetry({
      event: "process_started",
      process_id: state.id,
      pid: state.pid,
      owner_caller_id: state.callerId,
      cwd: state.cwd,
      started_at: state.startedAt,
    }, state.ownerContext);
    return { ...processResponseState(state.startedAt, true), process_id: state.id, pid: state.pid, cwd: state.cwd, running: true } as const;
  }

  read(processId: string, maxChars = MAX_READ_CHARS): Record<string, unknown> {
    this.pruneCompleted();
    const limit = Math.max(1, Math.min(maxChars, MAX_READ_CHARS));
    const state = this.processes.get(processId);
    if (!state) {
      const receipt = this.readReceipt(processId, limit);
      if (receipt) return receipt;
      throw new Error(`Unknown process_id: ${processId}`);
    }
    const command = state.command.slice(0, MAX_COMMAND_REPORT_CHARS);
    const stdout = state.stdout.tail(limit);
    const stderr = state.stderr.tail(limit);
    const observer = currentTelemetryContext();
    const observerCallerId = observer.caller_id ?? "caller_unknown";
    state.lastReadRevisionByCaller.set(observerCallerId, state.revision);
    emitTelemetry({
      event: "process_read",
      process_id: state.id,
      pid: state.pid,
      owner_caller_id: state.callerId,
      caller_id: observerCallerId,
      running: state.exitCode === null,
      reassociated: Boolean(observer.caller_id && observer.caller_id !== state.callerId),
    }, observer);
    return {
      ...processResponseState(state.startedAt, state.exitCode === null, state.finishedAt),
      process_id: state.id,
      pid: state.pid,
      command,
      ...((state.command.length > MAX_COMMAND_REPORT_CHARS) ? { command_truncated: true } : {}),
      cwd: state.cwd,
      running: state.exitCode === null,
      stdout: stdout.text,
      stderr: stderr.text,
      exit_code: state.exitCode,
      signal: state.signal ?? null,
      started_at: state.startedAt,
      finished_at: state.finishedAt ?? null,
      ...(stdout.truncated ? { stdout_truncated: true, stdout_dropped_from_start: stdout.dropped } : {}),
      ...(stderr.truncated ? { stderr_truncated: true, stderr_dropped_from_start: stderr.dropped } : {}),
      ...(state.error ? { error: state.error } : {}),
    };
  }

  async readWithWait(processId: string, maxChars = MAX_READ_CHARS, waitMs = 0): Promise<Record<string, unknown>> {
    const boundedWaitMs = Math.max(0, Math.min(waitMs, 10_000));
    const state = this.processes.get(processId);
    if (!state) {
      const receipt = this.readReceipt(processId, maxChars);
      if (receipt) return receipt;
      return await this.requestRemoteControl(processId, "read", currentTelemetryContext(), maxChars, boundedWaitMs);
    }
    if (boundedWaitMs === 0 || state.exitCode !== null) return this.read(processId, maxChars);
    const observer = currentTelemetryContext();
    const observerCallerId = observer.caller_id ?? "caller_unknown";
    const lastReadRevision = state.lastReadRevisionByCaller.get(observerCallerId) ?? 0;
    if (state.revision > lastReadRevision) return this.read(processId, maxChars);

    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        state.waiters.delete(finish);
        resolve();
      };
      state.waiters.add(finish);
      timer = setTimeout(finish, boundedWaitMs);
    });
    return this.read(processId, maxChars);
  }

  async kill(processId: string): Promise<Record<string, unknown>> {
    const observer = currentTelemetryContext();
    const state = this.processes.get(processId);
    if (!state) {
      const receipt = this.readReceipt(processId, MAX_READ_CHARS);
      if (receipt) {
        return {
          process_id: processId,
          pid: receipt.pid,
          killed: false,
          already_exited: true,
          exit_code: receipt.exit_code,
        };
      }
      return await this.requestRemoteControl(processId, "kill", observer);
    }
    if (state.exitCode !== null) {
      emitTelemetry({
        event: "process_kill_skipped",
        process_id: state.id,
        pid: state.pid,
        owner_caller_id: state.callerId,
        caller_id: observer.caller_id ?? "caller_unknown",
        reason: "already_exited",
      }, observer);
      return { process_id: state.id, pid: state.pid, killed: false, already_exited: true, exit_code: state.exitCode };
    }

    emitTelemetry({
      event: "process_kill_requested",
      process_id: state.id,
      pid: state.pid,
      owner_caller_id: state.callerId,
      caller_id: observer.caller_id ?? "caller_unknown",
      reassociated: Boolean(observer.caller_id && observer.caller_id !== state.callerId),
    }, observer);
    const killResult = await taskkillTree(state.pid);
    await Promise.race([state.done, delay(KILL_SETTLE_MS)]);
    if (state.exitCode === null) {
      emitTelemetry({
        event: "process_kill_incomplete",
        process_id: state.id,
        pid: state.pid,
        owner_caller_id: state.callerId,
        caller_id: observer.caller_id ?? "caller_unknown",
        kill_timed_out: killResult.timedOut,
      }, observer);
      return {
        process_id: state.id,
        pid: state.pid,
        killed: false,
        kill_requested: true,
        running: true,
        kill_timed_out: killResult.timedOut,
        error: `Process tree for ${processId} did not terminate within the bounded kill window`,
      };
    }
    emitTelemetry({
      event: "process_killed",
      process_id: state.id,
      pid: state.pid,
      owner_caller_id: state.callerId,
      caller_id: observer.caller_id ?? "caller_unknown",
      exit_code: state.exitCode,
      signal: state.signal ?? null,
    }, observer);
    return { process_id: state.id, pid: state.pid, killed: true, running: false, exit_code: state.exitCode, signal: state.signal ?? null };
  }

  hasLiveScope(scope: string): boolean {
    const candidate = scope.startsWith("process:") ? scope.slice("process:".length) : scope;
    const state = this.processes.get(candidate);
    return Boolean(state && state.exitCode === null);
  }

}
