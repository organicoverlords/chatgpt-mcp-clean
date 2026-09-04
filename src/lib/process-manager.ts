import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { currentTelemetryContext, emitTelemetry, withTelemetryContext, type TelemetryContext } from "./transport-telemetry.js";

const MAX_CAPTURE_CHARS = 100_000;
// Current live MCPv3 capability was revalidated on 2026-09-04 with a single 31,000+
// character read_output response. Keep the logical read/page contract at 32k; do not
// reintroduce the stale August 6k transport assumption.
const MAX_READ_CHARS = 32_000;
const MAX_COMMAND_REPORT_CHARS = 4_000;
const COMPLETED_RETENTION_MS = 30 * 60 * 1000;
const RECEIPT_ARCHIVE_RETENTION_DAYS = 7;
const RECEIPT_ARCHIVE_RETENTION_MS = RECEIPT_ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const RECEIPT_PRUNE_INTERVAL_MS = 60_000;
const RECEIPT_ARCHIVE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_COMPLETED_PROCESSES = 64;
const TASKKILL_TIMEOUT_MS = 2_000;
const KILL_SETTLE_MS = 1_000;
const DEFAULT_MAX_LIVE_PER_CALLER = 5;
const CONTROL_POLL_MS = 100;
const CONTROL_HANDOFF_OVERHEAD_MS = 1_500;
const CONTROL_KILL_TIMEOUT_MS = TASKKILL_TIMEOUT_MS + KILL_SETTLE_MS + CONTROL_HANDOFF_OVERHEAD_MS;
const CONTROL_RETENTION_MS = COMPLETED_RETENTION_MS;
const CONTROL_PRUNE_INTERVAL_MS = 60_000;
type CapturedChild = ChildProcessByStdio<null, Readable, Readable>;

type ProcessManagerOptions = {
  maxLivePerCaller?: number;
  maxCompletedProcesses?: number;
  receiptDirectory?: string;
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

  full(): { text: string; truncated: boolean } {
    return { text: this.chunks.join(""), truncated: this.truncated };
  }
}

type OutputCursor = { stdout: number; stderr: number };

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

// PowerShell 7 is the single supported shell runtime. Keep an absolute deterministic
// path and fail closed if it disappears; never silently fall back to Windows PowerShell 5.1.
const POWERSHELL_EXE = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
if (!existsSync(POWERSHELL_EXE)) throw new Error(`Required PowerShell 7 runtime is missing: ${POWERSHELL_EXE}`);

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

function powershellCodeMask(command: string): string {
  const masked = command.split("");
  const blank = (from: number, to: number) => { for (let index = from; index < to; index += 1) if (masked[index] !== "\r" && masked[index] !== "\n") masked[index] = " "; };
  let index = 0;
  while (index < command.length) {
    if (command.startsWith("<#", index)) {
      const end = command.indexOf("#>", index + 2);
      const stop = end < 0 ? command.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    const char = command[index]!;
    if (char === "#") {
      const end = command.indexOf("\n", index + 1);
      const stop = end < 0 ? command.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if ((char === "@" && (command[index + 1] === "'" || command[index + 1] === '\"')) && (command[index + 2] === "\r" || command[index + 2] === "\n")) {
      const quote = command[index + 1]!;
      const terminator = `${quote}@`;
      let cursor = index + 2;
      let stop = command.length;
      while (cursor < command.length) {
        const lineStart = cursor === 0 || command[cursor - 1] === "\n";
        if (lineStart && command.startsWith(terminator, cursor)) { stop = cursor + 2; break; }
        cursor += 1;
      }
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === "'" || char === '\"') {
      const quote = char;
      const begin = index;
      index += 1;
      while (index < command.length) {
        if (quote === "'" && command[index] === "'" && command[index + 1] === "'") { index += 2; continue; }
        if (quote === '\"' && command[index] === "`") { index += 2; continue; }
        if (command[index] === quote) { index += 1; break; }
        index += 1;
      }
      blank(begin, index);
      continue;
    }
    if (char === "`" && index + 1 < command.length) {
      blank(index, index + 2);
      index += 2;
      continue;
    }
    index += 1;
  }
  return masked.join("");
}

function driveRootRecursiveScanError(command: string, code: string): string | undefined {
  const boundaries = [...code.matchAll(/[;\r\n]/g)].map((match) => match.index ?? 0);
  const starts = [0, ...boundaries.map((index) => index + 1)];
  const ends = [...boundaries, command.length];
  const rootDrive = /(?:^|[\s,(=])(?:["']?[A-Za-z]:[\\/](?:\*)?["']?)(?=$|[\s,;)|])/i;
  for (let segmentIndex = 0; segmentIndex < starts.length; segmentIndex += 1) {
    const start = starts[segmentIndex]!;
    const end = ends[segmentIndex]!;
    const rawSegment = command.slice(start, end);
    const codeSegment = code.slice(start, end);
    if (!rootDrive.test(rawSegment)) continue;
    if (/\b(?:Get-ChildItem|gci|dir|ls)\b/i.test(codeSegment) && /-(?:Recurse|r)\b/i.test(codeSegment)) {
      return "recursive enumeration from a drive root is blocked; use an explicit project or subdirectory root";
    }
    if (/\b(?:rg|rg\.exe|ripgrep|fd|fd\.exe)\b/i.test(codeSegment)) {
      return "recursive native search from a drive root is blocked; use an explicit project or subdirectory root";
    }
    if (/\bwhere(?:\.exe)?\b/i.test(codeSegment) && /\/R\b/i.test(codeSegment)) {
      return "recursive native search from a drive root is blocked; use an explicit project or subdirectory root";
    }
    if (/\bfindstr(?:\.exe)?\b/i.test(codeSegment) && /\/S\b/i.test(codeSegment)) {
      return "recursive native search from a drive root is blocked; use an explicit project or subdirectory root";
    }
    if (/\bcmd(?:\.exe)?\b/i.test(codeSegment) && /\bdir\b/i.test(codeSegment) && /\/S\b/i.test(codeSegment)) {
      return "recursive native enumeration from a drive root is blocked; use an explicit project or subdirectory root";
    }
    if (/\btree(?:\.com|\.exe)?\b/i.test(codeSegment)) {
      return "drive-root tree enumeration is blocked; use an explicit project or subdirectory root";
    }
  }
  return undefined;
}

function powershellPreflightError(command: string): string | undefined {
  const code = powershellCodeMask(command);
  const rootScanError = driveRootRecursiveScanError(command, code);
  if (rootScanError) return rootScanError;
  const automaticVariable = String.raw`\$(?:(?:global|script|local|private):)?(?:PID|args)`;
  const writePattern = new RegExp(`${automaticVariable}\\s*(?:\\+\\+|--|[+*/%?-]?=)|(?:\\+\\+|--)\\s*${automaticVariable}`, "i");
  if (writePattern.test(code)) {
    return "do not assign to or increment automatic $PID/$args variables; use a different helper name";
  }

  const stack: Array<{ char: string; controlBlock: boolean }> = [];
  const closing: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index]!;
    if (char === "(" || char === "[" || char === "{") {
      let controlBlock = false;
      if (char === "{") {
        const before = code.slice(Math.max(0, index - 500), index);
        controlBlock = /(?:^|[;}\n])\s*(?:foreach|for|while|if|elseif|switch)\s*\([^{}]*\)\s*$/i.test(before)
          || /(?:^|[;}\n])\s*(?:else|try|catch|finally|do)\s*$/i.test(before);
      }
      stack.push({ char, controlBlock });
      continue;
    }
    if (char !== ")" && char !== "]" && char !== "}") continue;
    const top = stack.pop();
    if (!top || top.char !== closing[char]) return `unbalanced PowerShell delimiter near '${char}'`;
    if (char === "}" && top.controlBlock) {
      let next = index + 1;
      while (next < code.length && /\s/.test(code[next]!)) next += 1;
      if (code[next] === "|") return "capture foreach/for/while/if/switch statement output before piping it";
    }
  }
  if (stack.length > 0) return `unbalanced PowerShell delimiter: missing close for '${stack[stack.length - 1]!.char}'`;
  return undefined;
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
  private readonly outputCursors = new Map<string, OutputCursor>();
  private readonly maxLivePerCaller: number;
  private readonly maxCompletedProcesses: number;
  private readonly receiptDirectory?: string;
  private readonly receiptArchiveDirectory?: string;
  private readonly controlRequestDirectory?: string;
  private readonly controlResponseDirectory?: string;
  private readonly controlRequestsInFlight = new Set<string>();
  private lastReceiptPruneAt = 0;
  private lastReceiptArchivePruneAt = 0;
  private lastControlPruneAt = 0;

  constructor(options: ProcessManagerOptions = {}) {
    this.maxLivePerCaller = options.maxLivePerCaller ?? DEFAULT_MAX_LIVE_PER_CALLER;
    this.maxCompletedProcesses = options.maxCompletedProcesses ?? MAX_COMPLETED_PROCESSES;
    this.receiptDirectory = options.receiptDirectory ? resolve(options.receiptDirectory) : undefined;
    if (this.receiptDirectory) {
      mkdirSync(this.receiptDirectory, { recursive: true });
      this.receiptArchiveDirectory = join(this.receiptDirectory, "archive");
      mkdirSync(this.receiptArchiveDirectory, { recursive: true });
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

  private receiptArchivePath(processId: string, finishedAt: string): string | undefined {
    if (!this.receiptArchiveDirectory || !PROCESS_ID_PATTERN.test(processId)) return undefined;
    const finishedMs = Date.parse(finishedAt);
    if (!Number.isFinite(finishedMs)) return undefined;
    const day = new Date(finishedMs).toISOString().slice(0, 10);
    const dayDirectory = join(this.receiptArchiveDirectory, day);
    mkdirSync(dayDirectory, { recursive: true });
    return join(dayDirectory, `${processId}.json`);
  }

  private persistArchivedReceipt(receipt: CompletedProcessReceipt): void {
    const path = this.receiptArchivePath(receipt.process_id, receipt.finished_at);
    if (!path || existsSync(path)) return;
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(receipt), { encoding: "utf8", flag: "wx" });
      renameSync(temporaryPath, path);
    } finally {
      try { unlinkSync(temporaryPath); } catch { /* already renamed or never created */ }
    }
  }

  private persistPreflightRejection(command: string, workingDirectory: string | undefined, callerId: string, reason: string): string | undefined {
    if (!this.receiptArchiveDirectory) return undefined;
    const rejectionId = randomUUID();
    const rejectedAt = new Date().toISOString();
    const dayDirectory = join(this.receiptArchiveDirectory, rejectedAt.slice(0, 10));
    mkdirSync(dayDirectory, { recursive: true });
    const path = join(dayDirectory, `rejected-${rejectionId}.json`);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const record = {
      version: 1,
      kind: "process_preflight_rejection",
      rejection_id: rejectionId,
      caller_id: callerId,
      command: command.slice(0, MAX_COMMAND_REPORT_CHARS),
      ...(command.length > MAX_COMMAND_REPORT_CHARS ? { command_truncated: true as const } : {}),
      working_directory: workingDirectory ?? null,
      reason,
      rejected_at: rejectedAt,
    };
    try {
      writeFileSync(temporaryPath, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
      renameSync(temporaryPath, path);
      this.pruneReceiptArchive();
      return rejectionId;
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* best-effort temporary cleanup */ }
      emitTelemetry({
        event: "process_preflight_rejection_archive_error",
        reason,
        error_message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private pruneReceiptArchive(now = Date.now()): void {
    if (!this.receiptArchiveDirectory) return;
    if (now - this.lastReceiptArchivePruneAt < RECEIPT_ARCHIVE_PRUNE_INTERVAL_MS) return;
    this.lastReceiptArchivePruneAt = now;
    const cutoff = now - RECEIPT_ARCHIVE_RETENTION_MS;
    let entries;
    try {
      entries = readdirSync(this.receiptArchiveDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
      const endOfDay = Date.parse(`${entry.name}T23:59:59.999Z`);
      if (!Number.isFinite(endOfDay) || endOfDay >= cutoff) continue;
      try { rmSync(join(this.receiptArchiveDirectory, entry.name), { recursive: true, force: true }); } catch { /* best-effort retention cleanup */ }
    }
  }

  private pruneReceipts(): void {
    if (!this.receiptDirectory) return;
    const now = Date.now();
    if (now - this.lastReceiptPruneAt < RECEIPT_PRUNE_INTERVAL_MS) return;
    this.lastReceiptPruneAt = now;
    let entries;
    try {
      entries = readdirSync(this.receiptDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || !PROCESS_ID_PATTERN.test(entry.name.slice(0, -5))) continue;
      const path = join(this.receiptDirectory, entry.name);
      let modifiedAt = now;
      let archived = false;
      try {
        modifiedAt = statSync(path).mtimeMs;
        const receipt = JSON.parse(readFileSync(path, "utf8")) as CompletedProcessReceipt;
        this.persistArchivedReceipt(receipt);
        archived = true;
      } catch {
        // Preserve unreadable or unarchived evidence instead of deleting it.
      }
      if (archived && now - modifiedAt > COMPLETED_RETENTION_MS) {
        try { unlinkSync(path); } catch { /* another clone may already have pruned it */ }
      }
    }
    this.pruneReceiptArchive(now);
  }

  private receiptReadPaths(processId: string): string[] {
    const hotPath = this.receiptPath(processId);
    if (!hotPath) return [];
    const paths = [hotPath];
    if (!this.receiptArchiveDirectory) return paths;
    for (let dayOffset = 0; dayOffset <= RECEIPT_ARCHIVE_RETENTION_DAYS; dayOffset += 1) {
      const day = new Date(Date.now() - dayOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      paths.push(join(this.receiptArchiveDirectory, day, `${processId}.json`));
    }
    return paths;
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
      try {
        this.persistArchivedReceipt(receipt);
        emitTelemetry({
          event: "process_receipt_archived",
          process_id: state.id,
          pid: state.pid,
          owner_caller_id: state.callerId,
        }, state.ownerContext);
      } catch (error) {
        emitTelemetry({
          event: "process_receipt_archive_error",
          process_id: state.id,
          pid: state.pid,
          owner_caller_id: state.callerId,
          error_message: error instanceof Error ? error.message : String(error),
        }, state.ownerContext);
      }
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
    this.pruneReceipts();
    let receipt: CompletedProcessReceipt | undefined;
    for (const path of this.receiptReadPaths(processId)) {
      try {
        receipt = JSON.parse(readFileSync(path, "utf8")) as CompletedProcessReceipt;
        break;
      } catch {
        // Try the hot receipt first, then the durable day-sharded archive.
      }
    }
    if (!receipt) return undefined;
    if (receipt.version !== 1 || receipt.process_id !== processId || typeof receipt.pid !== "number" || typeof receipt.command !== "string" || typeof receipt.cwd !== "string" || typeof receipt.stdout !== "string" || typeof receipt.stderr !== "string" || typeof receipt.started_at !== "string" || typeof receipt.finished_at !== "string") {
      return undefined;
    }
    const limit = Math.max(1, Math.min(maxChars, MAX_READ_CHARS));
    const observer = currentTelemetryContext();
    const observerCallerId = observer.caller_id ?? "caller_unknown";
    emitTelemetry({
      event: "process_receipt_read",
      process_id: receipt.process_id,
      pid: receipt.pid,
      owner_caller_id: receipt.caller_id,
      caller_id: observerCallerId,
    }, observer);
    const legacy = {
      ...processResponseState(receipt.started_at, false, receipt.finished_at),
      process_id: receipt.process_id,
      pid: receipt.pid,
      command: receipt.command,
      ...(receipt.command_truncated ? { command_truncated: true } : {}),
      cwd: receipt.cwd,
      running: false,
      stdout: receipt.stdout.slice(-limit),
      stderr: receipt.stderr.slice(-limit),
      exit_code: receipt.exit_code,
      signal: receipt.signal,
      started_at: receipt.started_at,
      finished_at: receipt.finished_at,
      ...(receipt.stdout_truncated || receipt.stdout.length > limit ? { stdout_truncated: true } : {}),
      ...(receipt.stderr_truncated || receipt.stderr.length > limit ? { stderr_truncated: true } : {}),
      ...(receipt.error ? { error: receipt.error } : {}),
    };
    const cursorExists = this.outputCursors.has(this.cursorKey(receipt.process_id, observerCallerId));
    const needsPaging = cursorExists || receipt.stdout.length + receipt.stderr.length > limit;
    return needsPaging
      ? this.pageOutput(legacy, receipt.stdout, receipt.stderr, observerCallerId, Boolean(receipt.stdout_truncated), Boolean(receipt.stderr_truncated), limit)
      : legacy;
  }

  private cursorKey(processId: string, callerId: string): string {
    return `${processId}:${callerId}`;
  }

  private pageOutput(
    legacy: Record<string, unknown>,
    fullStdout: string,
    fullStderr: string,
    callerId: string,
    captureStdoutTruncated: boolean,
    captureStderrTruncated: boolean,
    requestedChars: number,
  ): Record<string, unknown> {
    const processId = String(legacy.process_id);
    const cursorKey = this.cursorKey(processId, callerId);
    const cursor = this.outputCursors.get(cursorKey) ?? { stdout: 0, stderr: 0 };
    const limit = Math.max(1, Math.min(requestedChars, MAX_READ_CHARS));
    const base: Record<string, unknown> = { ...legacy, stdout: "", stderr: "" };
    delete base.stdout_dropped_from_start;
    delete base.stderr_dropped_from_start;
    if (!captureStdoutTruncated) delete base.stdout_truncated;
    if (!captureStderrTruncated) delete base.stderr_truncated;

    const remainingStdout = fullStdout.slice(cursor.stdout);
    const remainingStderr = fullStderr.slice(cursor.stderr);
    const stdoutCount = Math.min(limit, remainingStdout.length);
    const stderrCount = Math.min(Math.max(0, limit - stdoutCount), remainingStderr.length);
    const nextStdout = cursor.stdout + stdoutCount;
    const nextStderr = cursor.stderr + stderrCount;
    const moreCaptured = nextStdout < fullStdout.length || nextStderr < fullStderr.length;
    const running = legacy.running === true;

    const result = {
      ...base,
      next_action: moreCaptured || running ? "READ_SAME_PROCESS_ID" : "STOP_READING",
      stdout: remainingStdout.slice(0, stdoutCount),
      stderr: remainingStderr.slice(0, stderrCount),
      output_page: {
        stdout_start: cursor.stdout,
        stdout_end: nextStdout,
        stdout_total: fullStdout.length,
        stderr_start: cursor.stderr,
        stderr_end: nextStderr,
        stderr_total: fullStderr.length,
        page_chars: stdoutCount + stderrCount,
        page_limit: limit,
        more: moreCaptured,
      },
    };

    if (moreCaptured || running) this.outputCursors.set(cursorKey, { stdout: nextStdout, stderr: nextStderr });
    else this.outputCursors.delete(cursorKey);
    return result;
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
    for (const state of remaining.slice(0, Math.max(0, remaining.length - this.maxCompletedProcesses))) this.processes.delete(state.id);
  }

  start(command: string, workingDirectory?: string, callerId = "caller_unknown"): { mcp_status: "OK"; process_state: "RUNNING" | "COMPLETED"; elapsed_ms: number; next_action: "READ_SAME_PROCESS_ID" | "STOP_READING"; process_id: string; pid: number; cwd: string; running: boolean } {
    this.pruneCompleted();
    const preflightError = powershellPreflightError(command);
    if (preflightError) {
      const rejectionId = this.persistPreflightRejection(command, workingDirectory, callerId, preflightError);
      emitTelemetry({ event: "process_preflight_rejected", reason: preflightError, ...(rejectionId ? { rejection_id: rejectionId } : {}) });
      throw new Error(`start_process_preflight_failed: ${preflightError}`);
    }
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
    let terminalObserved = false;
    const observeTerminal = (code: number | null, signal: NodeJS.Signals | null) => {
      if (state.exitCode === null) state.exitCode = code ?? -1;
      if (signal) state.signal = signal;
      if (!state.finishedAt) state.finishedAt = new Date().toISOString();
      this.markProcessChanged(state);
      this.persistReceipt(state);
      if (terminalObserved) return;
      terminalObserved = true;
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
    };
    child.once("error", (error) => {
      state.error = error.message;
      emitTelemetry({
        event: "process_error",
        process_id: state.id,
        pid: state.pid,
        owner_caller_id: state.callerId,
        error_code: "code" in error ? error.code : null,
        error_message: error.message,
      }, state.ownerContext);
      observeTerminal(-1, null);
    });
    // `exit` tracks the owned PID. `close` waits for stdio handles too, and on Windows a
    // descendant can keep an inherited pipe open after the owned PID is already gone.
    // Treat the PID exit as terminal immediately; let `close` refresh the receipt with any
    // final buffered stdout/stderr without keeping MCP in a false running state.
    child.once("exit", (code, signal) => observeTerminal(code, signal));
    child.once("close", (code, signal) => observeTerminal(code, signal));
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

  async startWithWait(
    command: string,
    workingDirectory?: string,
    callerId = "caller_unknown",
    waitMs = 750,
  ): Promise<Record<string, unknown>> {
    const started = this.start(command, workingDirectory, callerId);
    const boundedWaitMs = Math.max(0, Math.min(waitMs, 10_000));
    if (boundedWaitMs === 0) return started;
    const state = this.processes.get(started.process_id);
    if (!state || state.exitCode !== null) return this.read(started.process_id, MAX_READ_CHARS, false);
    await Promise.race([state.done, delay(boundedWaitMs)]);
    return this.read(started.process_id, MAX_READ_CHARS, false);
  }

  read(processId: string, maxChars = MAX_READ_CHARS, markRead = true): Record<string, unknown> {
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
    const fullStdout = state.stdout.full();
    const fullStderr = state.stderr.full();
    const observer = currentTelemetryContext();
    const observerCallerId = observer.caller_id ?? "caller_unknown";
    if (markRead) state.lastReadRevisionByCaller.set(observerCallerId, state.revision);
    emitTelemetry({
      event: "process_read",
      process_id: state.id,
      pid: state.pid,
      owner_caller_id: state.callerId,
      caller_id: observerCallerId,
      running: state.exitCode === null,
      reassociated: Boolean(observer.caller_id && observer.caller_id !== state.callerId),
    }, observer);
    const legacy = {
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
    // A running process owns a moving bounded capture. Keep live reads as ordinary bounded
    // tail snapshots; starting a cursor against that moving window can skip the eventual
    // retained tail as old bytes roll out. Lossless paging begins only after completion,
    // when the retained 100k snapshot is stable.
    const cursorExists = this.outputCursors.has(this.cursorKey(state.id, observerCallerId));
    const needsPaging = state.exitCode !== null && (cursorExists || fullStdout.text.length + fullStderr.text.length > limit);
    return needsPaging
      ? this.pageOutput(legacy, fullStdout.text, fullStderr.text, observerCallerId, fullStdout.truncated, fullStderr.truncated, limit)
      : legacy;
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
    if (state.exitCode === null && state.revision <= lastReadRevision) {
      return {
        ...processResponseState(state.startedAt, true),
        process_id: state.id,
        pid: state.pid,
        running: true,
        stdout: "",
        stderr: "",
        no_change: true,
      };
    }
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
