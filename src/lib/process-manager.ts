import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Readable } from "node:stream";

const MAX_CAPTURE_CHARS = 4_000_000;
// Keep foreground HTTP calls below the connector/Funnel response timeout. Long
// work must use start_process + read_output so the initial MCP call returns
// immediately instead of leaving a request open until the connector gives up.
export const MAX_FOREGROUND_TIMEOUT_SECONDS = 60;
const DEFAULT_TIMEOUT_SECONDS = MAX_FOREGROUND_TIMEOUT_SECONDS;
const COMPLETED_RETENTION_MS = 30 * 60 * 1000;
const MAX_COMPLETED_PROCESSES = 64;
type CapturedChild = ChildProcessByStdio<null, Readable, Readable>;

type ProcessState = {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  child: CapturedChild;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  done: Promise<void>;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  cwd: string;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
};

function appendCapture(current: string, chunk: Buffer | string): { value: string; truncated: boolean } {
  const next = current + chunk.toString();
  if (next.length <= MAX_CAPTURE_CHARS) return { value: next, truncated: false };
  return { value: next.slice(-MAX_CAPTURE_CHARS), truncated: true };
}

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

async function taskkillTree(pid: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", reject);
    killer.once("close", (code) => resolve(code ?? 1));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ProcessManager {
  private readonly processes = new Map<string, ProcessState>();

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

  async execute(command: string, workingDirectory?: string, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS): Promise<CommandResult> {
    const cwd = normalizedCwd(workingDirectory);
    const boundedTimeoutSeconds = Math.min(Math.max(1, timeoutSeconds), MAX_FOREGROUND_TIMEOUT_SECONDS);
    const child = powershell(command, cwd);
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;

    const result = new Promise<CommandResult>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer | string) => {
        const captured = appendCapture(stdout, chunk);
        stdout = captured.value;
        stdoutTruncated ||= captured.truncated;
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const captured = appendCapture(stderr, chunk);
        stderr = captured.value;
        stderrTruncated ||= captured.truncated;
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        resolve({
          stdout,
          stderr,
          exit_code: code,
          timed_out: timedOut,
          cwd,
          ...(stdoutTruncated ? { stdout_truncated: true } : {}),
          ...(stderrTruncated ? { stderr_truncated: true } : {}),
        });
      });
    });

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      void taskkillTree(child.pid ?? -1).catch(() => undefined);
    }, boundedTimeoutSeconds * 1000);
    try {
      return await result;
    } finally {
      clearTimeout(timer);
    }
  }

  start(command: string, workingDirectory?: string): { process_id: string; pid: number; cwd: string; running: boolean } {
    this.pruneCompleted();
    const cwd = normalizedCwd(workingDirectory);
    const child = powershell(command, cwd);
    if (!child.pid) throw new Error("Background process did not receive a PID");

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const state: ProcessState = {
      id: randomUUID(),
      pid: child.pid,
      command,
      cwd,
      child,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      startedAt: new Date().toISOString(),
      exitCode: null,
      done,
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      const captured = appendCapture(state.stdout, chunk);
      state.stdout = captured.value;
      state.stdoutTruncated ||= captured.truncated;
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const captured = appendCapture(state.stderr, chunk);
      state.stderr = captured.value;
      state.stderrTruncated ||= captured.truncated;
    });
    child.once("error", (error) => {
      state.error = error.message;
      if (state.exitCode === null) state.exitCode = -1;
    });
    child.once("close", (code, signal) => {
      if (state.exitCode === null) state.exitCode = code;
      state.signal = signal;
      state.finishedAt = new Date().toISOString();
      resolveDone();
    });
    this.processes.set(state.id, state);
    return { process_id: state.id, pid: state.pid, cwd: state.cwd, running: true };
  }

  read(processId: string, maxChars = 200_000): Record<string, unknown> {
    this.pruneCompleted();
    const state = this.requireProcess(processId);
    const limit = Math.max(1, Math.min(maxChars, MAX_CAPTURE_CHARS));
    return {
      process_id: state.id,
      pid: state.pid,
      command: state.command,
      cwd: state.cwd,
      running: state.exitCode === null,
      stdout: state.stdout.slice(-limit),
      stderr: state.stderr.slice(-limit),
      exit_code: state.exitCode,
      signal: state.signal ?? null,
      started_at: state.startedAt,
      finished_at: state.finishedAt ?? null,
      ...(state.stdoutTruncated ? { stdout_truncated: true } : {}),
      ...(state.stderrTruncated ? { stderr_truncated: true } : {}),
      ...(state.error ? { error: state.error } : {}),
    };
  }

  async kill(processId: string): Promise<Record<string, unknown>> {
    const state = this.requireProcess(processId);
    if (state.exitCode !== null) return { process_id: state.id, pid: state.pid, killed: false, already_exited: true, exit_code: state.exitCode };

    await taskkillTree(state.pid);
    await Promise.race([state.done, delay(5_000)]);
    if (state.exitCode === null) {
      await taskkillTree(state.pid).catch(() => undefined);
      await Promise.race([state.done, delay(2_000)]);
    }
    if (state.exitCode === null) throw new Error(`Process tree for ${processId} did not terminate`);
    return { process_id: state.id, pid: state.pid, killed: true, running: false, exit_code: state.exitCode, signal: state.signal ?? null };
  }

  hasLiveScope(scope: string): boolean {
    const candidate = scope.startsWith("process:") ? scope.slice("process:".length) : scope;
    const state = this.processes.get(candidate);
    return Boolean(state && state.exitCode === null);
  }

  private requireProcess(processId: string): ProcessState {
    const state = this.processes.get(processId);
    if (!state) throw new Error(`Unknown process_id: ${processId}`);
    return state;
  }
}

