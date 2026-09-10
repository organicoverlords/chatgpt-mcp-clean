import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir as mkdirAsync, readFile as readFileAsync, readdir as readdirAsync, rename as renameAsync, stat as statAsync, unlink as unlinkAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
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
const TASKKILL_TIMEOUT_MS = 5_000;
const KILL_SETTLE_MS = 1_000;
const DEFAULT_MAX_LIVE_PER_CALLER = 4;
// Shared-host concurrency is opt-in only; normal isolation is per caller/GPT.
const MAX_CONFIGURED_LIVE_TOTAL = 80;
const HOST_ADMISSION_DIRECTORY = ".host-admission";
const CONTROL_POLL_MS = 100;
const CONTROL_HANDOFF_OVERHEAD_MS = 1_500;
const CONTROL_KILL_TIMEOUT_MS = TASKKILL_TIMEOUT_MS + KILL_SETTLE_MS + CONTROL_HANDOFF_OVERHEAD_MS;
const CONTROL_RETENTION_MS = COMPLETED_RETENTION_MS;
const CONTROL_PRUNE_INTERVAL_MS = 60_000;

type ProcessManagerOptions = {
  maxLivePerCaller?: number;
  maxLiveTotal?: number;
  maxCompletedProcesses?: number;
  receiptDirectory?: string;
};

type CompletedProcessReceipt = {
  version: 1;
  process_id: string;
  pid: number;
  caller_id: string;
  request_id?: string;
  audit_schema?: "process-output-evidence.v1";
  retained_stdout_chars?: number;
  retained_stderr_chars?: number;
  retained_output_chars?: number;
  retained_stdout_bytes?: number;
  retained_stderr_bytes?: number;
  retained_output_bytes?: number;
  stdout_sha256?: string;
  stderr_sha256?: string;
  evidence_completeness?: "complete" | "bounded";
  execution_outcome?: "success" | "nonzero_exit" | "signaled" | "error" | "unknown";
  command: string;
  command_truncated?: true;
  submitted_command?: string;
  submitted_command_truncated?: true;
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

type HostAdmissionRecord = {
  version: 1;
  process_id: string;
  manager_pid: number;
  child_pid: number | null;
  claimed_at: string;
};

type ProcessState = {
  id: string;
  pid: number;
  callerId: string;
  ownerContext: TelemetryContext;
  command: string;
  submittedCommand?: string;
  cwd: string;
  launching: boolean;
  terminalObserved: boolean;
  resolveDone: () => void;
  killRequested: boolean;
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
  if (!isAbsolute(workingDirectory)) throw new Error(`working_directory must be an absolute path, received "${workingDirectory}"`);
  return resolve(workingDirectory);
}

async function boundedValidatedCwd(workingDirectory?: string): Promise<string> {
  const resolved = normalizedCwd(workingDirectory);
  if (!workingDirectory) return resolved;
  const validation = statAsync(resolved).then((stats) => stats.isDirectory() ? "ok" as const : "not_directory" as const).catch(() => "missing" as const);
  const outcome = await Promise.race([validation, delay(250).then(() => "timeout" as const)]);
  if (outcome === "missing") throw new Error(`working_directory does not exist: "${resolved}"`);
  if (outcome === "not_directory") throw new Error(`working_directory is not a directory: "${resolved}"`);
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

function tempRootMentioned(rawSegment: string): boolean {
  const roots = [
    process.env.TEMP || "",
    process.env.TMP || "",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Temp") : "",
    String.raw`$env:TEMP`,
    String.raw`$env:TMP`,
    String.raw`$env:LOCALAPPDATA\Temp`,
    String.raw`%TEMP%`,
    String.raw`%TMP%`,
    String.raw`%LOCALAPPDATA%\Temp`,
  ].filter(Boolean).map((value) => value.replaceAll("/", "\\").toLowerCase());
  const normalized = rawSegment.replaceAll("/", "\\").toLowerCase();
  const delimiter = (char: string | undefined) => !char || /[\s,;)|"'`=]/.test(char);
  for (const root of new Set(roots)) {
    let offset = 0;
    while (offset < normalized.length) {
      const index = normalized.indexOf(root, offset);
      if (index < 0) break;
      const before = index > 0 ? normalized[index - 1] : undefined;
      const afterIndex = index + root.length;
      const after = normalized[afterIndex];
      const exactBoundary = delimiter(before) && (delimiter(after) || (after === "\\" && (delimiter(normalized[afterIndex + 1]) || normalized[afterIndex + 1] === "*")));
      if (exactBoundary) return true;
      offset = index + root.length;
    }
  }
  return false;
}

function topLevelPowerShellPipelineSlices(start: number, end: number, code: string): Array<{ start: number; end: number }> {
  const slices: Array<{ start: number; end: number }> = [];
  const stack: string[] = [];
  const closing: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let sliceStart = start;
  for (let index = start; index < end; index += 1) {
    const char = code[index]!;
    if (char === "(" || char === "[" || char === "{") { stack.push(char); continue; }
    if (char === ")" || char === "]" || char === "}") {
      if (stack[stack.length - 1] === closing[char]) stack.pop();
      continue;
    }
    if (char === "|" && stack.length === 0 && code[index - 1] !== "|" && code[index + 1] !== "|") {
      slices.push({ start: sliceStart, end: index });
      sliceStart = index + 1;
    }
  }
  slices.push({ start: sliceStart, end });
  return slices;
}

function tempRootRecursiveScanError(command: string, code: string): string | undefined {
  const boundaries = [...code.matchAll(/[;\r\n]/g)].map((match) => match.index ?? 0);
  const starts = [0, ...boundaries.map((index) => index + 1)];
  const ends = [...boundaries, command.length];
  const tempEnumerationVariables = new Set<string>();

  for (let segmentIndex = 0; segmentIndex < starts.length; segmentIndex += 1) {
    const start = starts[segmentIndex]!;
    const end = ends[segmentIndex]!;
    let tempProducerInPipeline = false;
    for (const slice of topLevelPowerShellPipelineSlices(start, end, code)) {
      const rawInvocation = command.slice(slice.start, slice.end);
      const codeInvocation = code.slice(slice.start, slice.end);
      const rootMentioned = tempRootMentioned(rawInvocation);

      if (rootMentioned) {
        const producer = /\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:Get-ChildItem|gci|dir|ls)\b/i.exec(codeInvocation);
        if (producer) tempEnumerationVariables.add(producer[1]!.toLowerCase());

        if (/\b(?:Get-ChildItem|gci|dir|ls)\b/i.test(codeInvocation) && /-(?:Recurse|r)\b/i.test(codeInvocation)) {
          return "recursive enumeration from the Temp root is blocked; use one explicit Temp subdirectory";
        }
        if (/\b(?:rg|rg\.exe|ripgrep|fd|fd\.exe)\b/i.test(codeInvocation)) {
          return "recursive native search from the Temp root is blocked; use one explicit Temp subdirectory";
        }
        if (/\bwhere(?:\.exe)?\b/i.test(codeInvocation) && /\/R\b/i.test(codeInvocation)) {
          return "recursive native search from the Temp root is blocked; use one explicit Temp subdirectory";
        }
        if (/\bfindstr(?:\.exe)?\b/i.test(codeInvocation) && /\/S\b/i.test(codeInvocation)) {
          return "recursive native search from the Temp root is blocked; use one explicit Temp subdirectory";
        }
        if (/\bcmd(?:\.exe)?\b/i.test(codeInvocation) && /\bdir\b/i.test(codeInvocation) && /\/S\b/i.test(codeInvocation)) {
          return "recursive native enumeration from the Temp root is blocked; use one explicit Temp subdirectory";
        }
        if (/\btree(?:\.com|\.exe)?\b/i.test(codeInvocation)) {
          return "Temp-root tree enumeration is blocked; use one explicit Temp subdirectory";
        }
        if (/\b(?:Get-ChildItem|gci|dir|ls)\b/i.test(codeInvocation)) tempProducerInPipeline = true;
        continue;
      }

      if (tempProducerInPipeline && /(?:\bForEach-Object\b|%(?=\s*\{))/i.test(codeInvocation)) {
        const automaticItem = String.raw`\$(?:_|PSItem)(?:\.FullName)?\b`;
        const sameStatement = String.raw`[^};|\r\n]{0,1200}`;
        const recurseAfterItem = new RegExp(`\\b(?:Get-ChildItem|gci|dir|ls)\\b${sameStatement}${automaticItem}${sameStatement}-(?:Recurse|r)\\b`, "i");
        const recurseBeforeItem = new RegExp(`\\b(?:Get-ChildItem|gci|dir|ls)\\b${sameStatement}-(?:Recurse|r)\\b${sameStatement}${automaticItem}`, "i");
        if (recurseAfterItem.test(codeInvocation) || recurseBeforeItem.test(codeInvocation)) {
          return "recursive Temp-root pipeline fan-out is blocked; enumerate or recurse one explicit Temp subdirectory at a time";
        }
      }
    }
  }

  // A broad root enumeration can be cheap at launch yet explode into many expensive
  // recursive walks in a foreach body. This exact pattern drove the 2026-09-10
  // paging/stall incident, so reject it before the first child is admitted.
  for (const producerVariable of tempEnumerationVariables) {
    const loop = new RegExp(`\\bforeach\\s*\\(\\s*\\$([A-Za-z_][A-Za-z0-9_]*)\\s+in\\s+\\$${producerVariable}\\b`, "gi");
    for (const match of code.matchAll(loop)) {
      const itemVariable = String(match[1] || "");
      if (!itemVariable) continue;
      const itemReference = `\\$${itemVariable}(?:\\.FullName)?\\b`;
      const sameStatement = String.raw`[^};|\r\n]{0,1200}`;
      const recurseAfterItem = new RegExp(`\\b(?:Get-ChildItem|gci|dir|ls)\\b${sameStatement}${itemReference}${sameStatement}-(?:Recurse|r)\\b`, "i");
      const recurseBeforeItem = new RegExp(`\\b(?:Get-ChildItem|gci|dir|ls)\\b${sameStatement}-(?:Recurse|r)\\b${sameStatement}${itemReference}`, "i");
      const loopRemainder = code.slice(match.index ?? 0);
      if (recurseAfterItem.test(loopRemainder) || recurseBeforeItem.test(loopRemainder)) {
        return "recursive Temp-root fan-out is blocked; enumerate or recurse one explicit Temp subdirectory at a time";
      }
    }
  }
  return undefined;
}

function hasUnescapedPowerShellExpansion(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "$" || !/[A-Za-z0-9_?^$({]/.test(value[index + 1] || "")) continue;
    let backticks = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === "`"; cursor -= 1) backticks += 1;
    if (backticks % 2 === 0) return true;
  }
  return false;
}

function nestedPowerShellCommandExpansionError(command: string, code: string): string | undefined {
  const shellPattern = /\b(?:powershell|pwsh)(?:\.exe)?\b/gi;
  for (const shell of code.matchAll(shellPattern)) {
    const shellStart = shell.index ?? 0;
    const boundaryOffset = code.slice(shellStart).search(/[;\r\n]/);
    const segmentEnd = boundaryOffset < 0 ? command.length : shellStart + boundaryOffset;
    const visibleSegment = code.slice(shellStart, segmentEnd);
    const commandOption = /-(?:Command)\b/i.exec(visibleSegment);
    if (!commandOption) continue;
    const optionEnd = shellStart + commandOption.index + commandOption[0].length;
    let payloadStart = optionEnd;
    while (payloadStart < segmentEnd && /\s/.test(command[payloadStart]!)) payloadStart += 1;
    if (command[payloadStart] !== '"') continue;
    const payload = command.slice(payloadStart + 1, segmentEnd);
    if (hasUnescapedPowerShellExpansion(payload)) {
      return "nested powershell/pwsh -Command double-quoted payload contains parent-expandable $ syntax; use C:\\Users\\Lauri\\.agents\\Invoke-LiteralScript.ps1 to transport the child script literally";
    }
  }
  return undefined;
}

function vaultRootMentioned(rawSegment: string): boolean {
  const userProfile = (process.env.USERPROFILE || "").trim();
  const roots = [
    ...(userProfile ? [join(userProfile, "Desktop", "vault")] : []),
    String.raw`$env:USERPROFILE\Desktop\vault`,
    String.raw`%USERPROFILE%\Desktop\vault`,
  ].map((value) => value.replaceAll("/", "\\").toLowerCase());
  const normalized = rawSegment.replaceAll("/", "\\").toLowerCase();
  const delimiter = (char: string | undefined) => !char || /[\s,;)|"'`=]/.test(char);
  for (const root of roots) {
    let offset = 0;
    while (offset < normalized.length) {
      const index = normalized.indexOf(root, offset);
      if (index < 0) break;
      const before = index > 0 ? normalized[index - 1] : undefined;
      const afterIndex = index + root.length;
      const after = normalized[afterIndex];
      const exactBoundary = delimiter(before) && (delimiter(after) || (after === "\\" && (delimiter(normalized[afterIndex + 1]) || normalized[afterIndex + 1] === "*")));
      if (exactBoundary) return true;
      offset = index + root.length;
    }
  }
  return false;
}

function vaultRootRecursiveScanError(command: string, code: string): string | undefined {
  const boundaries = [...code.matchAll(/[;\r\n]/g)].map((match) => match.index ?? 0);
  const starts = [0, ...boundaries.map((index) => index + 1)];
  const ends = [...boundaries, command.length];
  for (let segmentIndex = 0; segmentIndex < starts.length; segmentIndex += 1) {
    const start = starts[segmentIndex]!;
    const end = ends[segmentIndex]!;
    const rawSegment = command.slice(start, end);
    const codeSegment = code.slice(start, end);
    if (!vaultRootMentioned(rawSegment)) continue;
    if (/\b(?:Get-ChildItem|gci|dir|ls)\b/i.test(codeSegment) && /-(?:Recurse|r)\b/i.test(codeSegment)) {
      return "recursive enumeration from the Vault root is blocked; use memory_bank.py/indexed lookup, an exact path, or an explicit Vault subdirectory";
    }
    if (/\b(?:rg|rg\.exe|ripgrep|fd|fd\.exe)\b/i.test(codeSegment)) {
      return "recursive native search from the Vault root is blocked; use memory_bank.py/indexed lookup, an exact path, or an explicit Vault subdirectory";
    }
    if (/\bwhere(?:\.exe)?\b/i.test(codeSegment) && /\/R\b/i.test(codeSegment)) {
      return "recursive native search from the Vault root is blocked; use memory_bank.py/indexed lookup, an exact path, or an explicit Vault subdirectory";
    }
    if (/\bfindstr(?:\.exe)?\b/i.test(codeSegment) && /\/S\b/i.test(codeSegment)) {
      return "recursive native search from the Vault root is blocked; use memory_bank.py/indexed lookup, an exact path, or an explicit Vault subdirectory";
    }
    if (/\bcmd(?:\.exe)?\b/i.test(codeSegment) && /\bdir\b/i.test(codeSegment) && /\/S\b/i.test(codeSegment)) {
      return "recursive native enumeration from the Vault root is blocked; use memory_bank.py/indexed lookup, an exact path, or an explicit Vault subdirectory";
    }
    if (/\btree(?:\.com|\.exe)?\b/i.test(codeSegment)) {
      return "Vault root tree enumeration is blocked; use memory_bank.py/indexed lookup, an exact path, or an explicit Vault subdirectory";
    }
  }
  return undefined;
}

function p3BuildSlotWaitError(command: string, code: string): string | undefined {
  const invokesP3Build = /\bInvoke-P3(?:HotSource)?Build\.ps1\b/i.test(command);
  const waitProcess = /\bWait-Process\b/i.test(code);
  const ubtWaitMarker = /\b(?:WAIT_FOREIGN_UBT|FOREIGN_UBT|WAIT_OWNER_PID|UnrealBuildTool|UBT)\b/i.test(command);
  const directP3Ubt = /\bUnrealBuildTool\.dll\b/i.test(command)
    && /\bp3Editor\b/i.test(command)
    && /(?:-Project=|\bp3\.uproject\b)/i.test(command);
  const waitsOnP3BuildMutex = /\bP3BuildGraphSlot_v3_[0-9]+\b/i.test(command)
    && /\.WaitOne\s*\(/i.test(code);

  if (waitProcess && (invokesP3Build || ubtWaitMarker)) {
    return "interactive P3 build-slot waits are blocked; let the P3 build wrapper fail fast and continue other scope";
  }
  if (waitsOnP3BuildMutex && directP3Ubt) {
    return "interactive P3 build-slot mutex waits are blocked; use the P3 build wrapper so contention fails fast";
  }

  const pollingForeignProcess = /\b(?:while|do)\b/i.test(code)
    && /\bGet-Process\b/i.test(code)
    && /\bStart-Sleep\b/i.test(code);
  if (invokesP3Build && pollingForeignProcess) {
    return "interactive P3 build-slot polling is blocked; let the P3 build wrapper fail fast and continue other scope";
  }
  return undefined;
}

function swarmRouteDecisionIsolationError(command: string, code: string): string | undefined {
  const boundaries = [...code.matchAll(/[;\r\n]/g)].map((match) => match.index ?? 0);
  const starts = [0, ...boundaries.map((index) => index + 1)];
  const ends = [...boundaries, command.length];
  let routeSegment = -1;

  for (let segmentIndex = 0; segmentIndex < starts.length; segmentIndex += 1) {
    const start = starts[segmentIndex]!;
    const end = ends[segmentIndex]!;
    const rawSegment = command.slice(start, end);
    const codeSegment = code.slice(start, end);
    const invokesPython = /\b(?:python|python3|py)(?:\.exe)?\b/i.test(codeSegment);
    const routeMatch = /\bswarm_route\.py['"]?\s+route\b/i.exec(rawSegment);
    const routeVerbOffset = routeMatch ? routeMatch[0].toLowerCase().lastIndexOf("route") : -1;
    const routeVerbVisible = routeMatch !== null && routeVerbOffset >= 0
      && codeSegment.slice(routeMatch.index + routeVerbOffset, routeMatch.index + routeVerbOffset + 5).toLowerCase() === "route";
    if (!invokesPython || !routeVerbVisible) continue;
    routeSegment = segmentIndex;
    if (/\|/.test(codeSegment) || /&&/.test(codeSegment)) {
      return "swarm_route.py route must run as a standalone start_process call; inspect its route result before executing assigned work";
    }
  }

  if (routeSegment < 0) return undefined;
  for (let segmentIndex = 0; segmentIndex < starts.length; segmentIndex += 1) {
    if (segmentIndex === routeSegment) continue;
    const codeSegment = code.slice(starts[segmentIndex]!, ends[segmentIndex]!);
    if (codeSegment.trim()) {
      return "swarm_route.py route must run as a standalone start_process call; inspect its route result before executing assigned work";
    }
  }
  return undefined;
}

const PROTECTED_CONTROL_PLANE_TERMINATION_ERROR = "protected MCP/Commander control-plane termination is blocked; preserve serving and recovery paths and use the documented gated recovery path";

function isProtectedControlPlaneProcessCommand(command: string): boolean {
  const protectedScript = String.raw`(?:Start-DesktopCommanderFallbackHidden|keepalive|home-direct-supervisor|home-direct-caddy-supervisor|launch-production|start-vps-native-tunnels)\.ps1`;
  const invokesProtectedScript = [
    new RegExp(String.raw`(?:^|[;\r\n])\s*[.&]\s*['"]?[^'";|\r\n]*[\\/]${protectedScript}`, "i"),
    new RegExp(String.raw`\b(?:powershell|pwsh)(?:\.exe)?\b[^;\r\n]*?(?:-File\s+)?['"]?[^'";|\r\n]*[\\/]${protectedScript}`, "i"),
    new RegExp(String.raw`(?:^|[;\r\n])\s*(?:[A-Za-z]:[\\/])?[^\s;'"|]*[\\/]${protectedScript}`, "i"),
    new RegExp(String.raw`(?:^|[;\r\n])\s*[.&]\s*['\"]?${protectedScript}\b`, "i"),
    new RegExp(String.raw`\b(?:powershell|pwsh)(?:\.exe)?\b[^;\r\n]*?-File\s+['\"]?${protectedScript}\b`, "i"),
  ].some((pattern) => pattern.test(command));
  const invokesDesktopCommander = /\bnpx(?:\.cmd|\.exe)?\b[^;\r\n]*@wonderwhy-er[\\/]desktop-commander(?:@[A-Za-z0-9._-]+)?\b[^;\r\n]*\bremote\b/i.test(command)
    || /\bnode(?:\.exe)?\b[^;\r\n]*@wonderwhy-er[\\/]desktop-commander[\\/]dist[\\/]index\.js\b/i.test(command);
  const invokesCanonicalClone = /(?:^|[\\/])scripts[\\/]start-minimal-clone\.ps1\b/i.test(command)
    && /(?:^|\s)-Port\s+3011\b/i.test(command)
    && !/(?:^|\s)-ValidateOnly\b/i.test(command);
  const invokesCanonicalServingRuntime = /\b(?:dist[\\/](?:index|front-door)\.js|src[\\/](?:index|front-door)\.ts)\b/i.test(command)
    && /(?:\bPORT\s*=\s*['"]?3011\b|\bFRONT_DOOR_PORT\s*=\s*['"]?3003\b|127\.0\.0\.1:(?:3011|3003)\b|10\.203\.0\.2:3011\b)/i.test(command);
  const invokesMcpTunnel = /McpVpsEdge/i.test(command)
    && /(?:vps_mcp_reverse_tunnel|start-tunnel\.ps1|start-vps-native-tunnels\.ps1)/i.test(command);
  return invokesProtectedScript || invokesDesktopCommander || invokesCanonicalClone || invokesCanonicalServingRuntime || invokesMcpTunnel;
}
function mcpProductionMutationError(command: string, code: string): string | undefined {
  const productionIngressError = "direct MCP production ingress mutation is blocked; use the documented redundant replacement/recovery scripts and prove the replacement off-path before changing serving production";

  const invokesObsoleteDatedCutoverHelper = /(?:^|[\\/])minimal-connectors[\\/]cutover-production-\d{8}\.ps1\b/i.test(command);
  if (invokesObsoleteDatedCutoverHelper) return productionIngressError;

  const replacementInternalScript = String.raw`(?:production-replacement-guardian|production-replacement-candidate)\.ps1\b`;
  const replacementInternalPath = String.raw`(?:[A-Za-z]:)?[^'";|\r\n]*?[\\/]scripts[\\/]${replacementInternalScript}`;
  const invokesReplacementInternal = [
    new RegExp(String.raw`(?:^|[;\r\n])\s*[.&]\s*['"]?${replacementInternalPath}`, "i"),
    new RegExp(String.raw`\b(?:powershell|pwsh)(?:\.exe)?\b[^;\r\n]*?(?:-File\s+)?['"]?${replacementInternalPath}`, "i"),
    new RegExp(String.raw`(?:^|[;\r\n])\s*(?:[A-Za-z]:[\\/])?[^\s;'"|]*[\\/]scripts[\\/]${replacementInternalScript}`, "i"),
  ].some((pattern) => pattern.test(command));
  if (invokesReplacementInternal) return productionIngressError;

  const invokesDirectEdgeMutation = /provision_edge_extras\.py\b/i.test(command)
    && /--caddy-only\b/i.test(command)
    && !/--render-caddy\b/i.test(command);
  if (invokesDirectEdgeMutation) return productionIngressError;

  const productionVpsHost = /(?:5[.]61[.]91[.]127|5-61-91-127[.]sslip[.]io|10[.]203[.]0[.]1)\b/i.test(command);
  const rawRemoteTransportInCode = /(?:^|[;&|{}\r\n])\s*(?:&\s*)?(?:ssh|scp|sftp|rsync|plink|pscp|psftp|winscp(?:[.]com|[.]exe)?)(?:[.]exe)?\b/im.test(code)
    || /\bStart-Process(?:\s+-FilePath)?\s+(?:ssh|scp|sftp|rsync|plink|pscp|psftp|winscp(?:[.]com|[.]exe)?)(?:[.]exe)?\b/i.test(code);
  const quotedRemoteTransportInvocation = /(?:&|Start-Process(?:\s+-FilePath)?)\s*['"][^'"\r\n]*(?:ssh|scp|sftp|rsync|plink|pscp|psftp|winscp(?:[.]com|[.]exe)?)(?:[.]exe)?['"]/i.test(command);
  const nestedShellRemoteTransport = /\b(?:cmd(?:[.]exe)?\s+\/(?:c|k)|(?:powershell|pwsh)(?:[.]exe)?\b|wsl(?:[.]exe)?\b|(?:bash|sh)(?:[.]exe)?\b)/i.test(code)
    && /\b(?:ssh|scp|sftp|rsync|plink|pscp|psftp|winscp(?:[.]com|[.]exe)?)(?:[.]exe)?\b/i.test(command);
  const interpreterRemoteLibrary = /\b(?:python|py|uv)(?:[.]exe)?\b/i.test(code)
    && /\b(?:asyncssh|paramiko|ssh2|node-ssh)\b/i.test(command);
  const invokesRawProductionVpsTransport = productionVpsHost
    && (rawRemoteTransportInCode || quotedRemoteTransportInvocation || nestedShellRemoteTransport || interpreterRemoteLibrary);
  if (invokesRawProductionVpsTransport) return productionIngressError;

  const startsReplacementInternalTask = /\b(?:Start-ScheduledTask|schtasks(?:\.exe)?\s+\/Run)\b/i.test(code)
    && /McpV3ProductionReplacement(?:Guardian|Candidate)/i.test(command);
  if (startsReplacementInternalTask) return productionIngressError;

  const caddyFileReference = /\/etc\/caddy\/Caddyfile\b/i.test(command);
  const contentMutationMatches = [...code.matchAll(/\b(?:Set-Content|Add-Content|Out-File)\b/gi)];
  const contentMutationCouldTargetCaddy = contentMutationMatches.some((match) => {
    const start = match.index ?? 0;
    let end = code.length;
    for (let index = start; index < code.length; index += 1) {
      if (/[;|}\r\n]/.test(code[index]!)) { end = index; break; }
    }
    const segment = command.slice(start, end);
    const cmdlet = String(match[0] ?? "").toLowerCase();
    const targetMatch = cmdlet === "out-file"
      ? /-FilePath\s+(?:'([^']*)'|"([^"]*)"|([^\s;|}]+))/i.exec(segment)
      : /-(?:LiteralPath|Path)\s+(?:'([^']*)'|"([^"]*)"|([^\s;|}]+))/i.exec(segment);
    if (!targetMatch) return true;
    const target = String(targetMatch[1] ?? targetMatch[2] ?? targetMatch[3] ?? "");
    if (!target || /[$`*?(){}]/.test(target)) return true;
    return /\/etc\/caddy\/Caddyfile\b/i.test(target);
  });
  const copyMatches = [...code.matchAll(/\bCopy-Item\b/gi)];
  const copyCouldTargetCaddy = copyMatches.some((match) => {
    const start = match.index ?? 0;
    let end = code.length;
    for (let index = start; index < code.length; index += 1) {
      if (/[;|}\r\n]/.test(code[index]!)) { end = index; break; }
    }
    const segment = command.slice(start, end);
    const destinationMatch = /-Destination\s+(?:'([^']*)'|"([^"]*)"|([^\s;|}]+))/i.exec(segment);
    if (!destinationMatch) return true;
    const destination = String(destinationMatch[1] ?? destinationMatch[2] ?? destinationMatch[3] ?? "");
    if (!destination || /[$`*?(){}]/.test(destination)) return true;
    return /\/etc\/caddy\/Caddyfile\b/i.test(destination);
  });
  const destructivePowerShellFileMutation = /\b(?:Move-Item|Remove-Item|Rename-Item)\b/i.test(code);
  const mutatesCaddy = caddyFileReference && (
    /(?:^|[\s;&|])(?:cp|mv|rm|install|tee)\b/i.test(command)
    || /\bsed\s+-[^\s]*i\b/i.test(command)
    || /(?:>|>>)\s*\/?etc\/caddy\/Caddyfile\b/i.test(command)
    || contentMutationCouldTargetCaddy
    || copyCouldTargetCaddy
    || destructivePowerShellFileMutation
  );
  const reloadsCaddy = /\b(?:systemctl\s+(?:reload|restart)\s+caddy|caddy\s+(?:reload|stop))\b/i.test(command);
  if (mutatesCaddy || reloadsCaddy) return productionIngressError;

  const mutatesProductionPortProxy = /\bnetsh(?:\.exe)?\s+interface\s+portproxy\s+(?:add|set|delete|reset)\b/i.test(command)
    && /(?:10\.203\.0\.2|(?:listen|connect)port\s*=\s*3011|\b3011\b)/i.test(command);
  if (mutatesProductionPortProxy) return productionIngressError;

  const productionWireGuardTarget = /(?:WireGuardTunnel\$mcp-wireguard|\bmcp-wireguard\b|10\.203\.0\.2\b)/i.test(command);
  const mutatesWireGuardService = productionWireGuardTarget && (
    /\b(?:Start|Stop|Restart|Set|Remove)-Service\b/i.test(code)
    || /\bsc(?:\.exe)?\s+(?:start|stop|delete|config)\b/i.test(code)
    || /\bnet(?:\.exe)?\s+(?:start|stop)\b/i.test(code)
    || (/\b(?:Invoke-CimMethod|Invoke-WmiMethod)\b/i.test(code) && /\b(?:StartService|StopService|ChangeStartMode|Delete)\b/i.test(command))
  );
  if (mutatesWireGuardService) return productionIngressError;

  const productionTaskTarget = /(?:McpV3Production3011|McpVpsEdgeTunnel)/i.test(command);
  const mutatesProductionTask = productionTaskTarget && (
    /\b(?:Start|Stop|Disable|Enable|Set|Register|Unregister)-ScheduledTask\b/i.test(code)
    || /\bschtasks(?:\.exe)?\s+\/(?:Run|End|Delete|Change|Create)\b/i.test(code)
  );
  if (mutatesProductionTask) return productionIngressError;

  const productionNetworkTarget = /(?:\bmcp-wireguard\b|10\.203\.0\.2\b|(?:local|listen|connect)?port\s*[=:]?\s*3011\b|McpV3Production3011|McpVpsEdgeTunnel)/i.test(command);
  const mutatesProductionFirewall = productionNetworkTarget && (
    /\b(?:New|Set|Remove|Disable|Enable)-NetFirewallRule\b/i.test(code)
    || /\bnetsh(?:\.exe)?\s+advfirewall\s+firewall\s+(?:add|delete|set)\s+rule\b/i.test(code)
  );
  const mutatesProductionRoute = productionNetworkTarget && (
    /\b(?:New|Set|Remove)-NetRoute\b/i.test(code)
    || /\broute(?:\.exe)?\s+(?:add|change|delete)\b/i.test(code)
    || /\bnetsh(?:\.exe)?\s+interface\s+(?:ipv4|ipv6)\s+(?:add|set|delete)\s+route\b/i.test(code)
  );
  const mutatesProductionAdapter = productionNetworkTarget && (
    /\b(?:Disable|Enable|Restart|Rename|Set)-NetAdapter\b/i.test(code)
    || /\bnetsh(?:\.exe)?\s+interface\s+set\s+interface\b/i.test(code)
  );
  const mutatesProductionAddress = productionNetworkTarget && (
    /\b(?:New|Set|Remove)-NetIPAddress\b/i.test(code)
    || /\bSet-NetIPInterface\b/i.test(code)
  );
  if (mutatesProductionFirewall || mutatesProductionRoute || mutatesProductionAdapter || mutatesProductionAddress) return productionIngressError;

  const servingEntrypoint = /\b(?:dist[\\/](?:index|front-door)\.js|src[\\/](?:index|front-door)\.ts)\b/i.test(command);
  const directServingRuntime = /(?:^|[;&|{}\r\n])\s*(?:&\s*)?(?:node|tsx|ts-node|bun|deno)(?:\.exe)?\b/im.test(code)
    || /\bStart-Process(?:\s+-FilePath)?\s+(?:node|tsx|ts-node|bun|deno)(?:\.exe)?\b/i.test(code)
    || /(?:&|Start-Process(?:\s+-FilePath)?)\s*['"][^'"\r\n]*(?:node|tsx|ts-node|bun|deno)(?:\.exe)?['"]/i.test(command)
    || (/\b(?:cmd(?:\.exe)?\s+\/(?:c|k)|(?:powershell|pwsh)(?:\.exe)?\b|wsl(?:\.exe)?\b|(?:bash|sh)(?:\.exe)?\b)/i.test(code)
      && /\b(?:node|tsx|ts-node|bun|deno)(?:\.exe)?\b/i.test(command))
    || /\bnpx(?:\.cmd|\.exe)?\s+(?:tsx|ts-node)\b/i.test(code);
  if (servingEntrypoint && directServingRuntime) return productionIngressError;

  const invokesCanonicalCloneHelper = /(?:^|[\\/])scripts[\\/]start-minimal-clone\.ps1\b/i.test(command)
    && /(?:^|\s)-Port\s+3011\b/i.test(command)
    && !/(?:^|\s)-ValidateOnly\b/i.test(command);
  if (invokesCanonicalCloneHelper) return productionIngressError;

  const terminatesProcess = /\b(?:Stop-Process|taskkill(?:\.exe)?|kill-process)\b/i.test(code)
    || (/\b(?:Invoke-CimMethod|Invoke-WmiMethod)\b/i.test(code) && /\bTerminate\b/i.test(command))
    || /\bwmic(?:\.exe)?\b[^\r\n;]*\bprocess\b[^\r\n;]*\bcall\s+terminate\b/i.test(command);
  const identifiesServingMcp = /(?:127\.0\.0\.1:(?:3011|3003)\/health|10\.203\.0\.2:3011|McpV3Production3011|ChatGPTMcpMinimal|dist[\\/]front-door\.js|dist[\\/]index\.js)/i.test(command);
  const identifiesOtherProtectedControlPlane = /(?:McpVpsEdgeTunnel|Start-DesktopCommanderFallbackHidden\.ps1|@wonderwhy-er[\\/]desktop-commander|desktop-commander[\\/]dist[\\/]index\.js|home-direct-(?:caddy-)?supervisor\.ps1|keepalive\.ps1|launch-production\.ps1|start-vps-native-tunnels\.ps1|vps_mcp_reverse_tunnel)/i.test(command);
  const selectsSharedControlHostByImage = /\bGet-Process\b[^\r\n;]*(?:\bnode(?:\.exe)?\b|\bpowershell(?:\.exe)?\b|\bpwsh(?:\.exe)?\b|\bpython(?:\.exe)?\b)/i.test(command)
    || /\bStop-Process\b[^\r\n;]*-Name\s+['"]?(?:node|powershell|pwsh|python)(?:\.exe)?['"]?\b/i.test(command)
    || /\btaskkill(?:\.exe)?\b[^\r\n;]*\/IM\s+['"]?(?:node|powershell|pwsh|python)(?:\.exe)?['"]?\b/i.test(command);
  if (terminatesProcess && identifiesServingMcp) return productionIngressError;
  if (terminatesProcess && (identifiesOtherProtectedControlPlane || selectsSharedControlHostByImage)) return PROTECTED_CONTROL_PLANE_TERMINATION_ERROR;

  return undefined;
}

type PowerShellCommandNormalization = { command: string; changed: boolean };

function normalizePowerShellControlStatementPipelines(command: string): PowerShellCommandNormalization {
  const code = powershellCodeMask(command);
  const stack: Array<{ char: string; controlStart?: number; autoNormalize?: boolean }> = [];
  const closing: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const insertions: Array<{ index: number; text: string }> = [];
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index]!;
    if (char === "(" || char === "[" || char === "{") {
      let controlStart: number | undefined;
      let autoNormalize = false;
      if (char === "{") {
        const beforeStart = Math.max(0, index - 500);
        const before = code.slice(beforeStart, index);
        const match = /(?:^|[;}\n])\s*(?:foreach|for|while|switch)\s*\([^{}]*\)\s*$/i.exec(before);
        if (match) {
          const keywordOffset = match[0].search(/\b(?:foreach|for|while|switch)\b/i);
          if (keywordOffset >= 0) {
            controlStart = beforeStart + (match.index ?? 0) + keywordOffset;
            autoNormalize = true;
          }
        }
      }
      stack.push({ char, controlStart, autoNormalize });
      continue;
    }
    if (char !== ")" && char !== "]" && char !== "}") continue;
    const top = stack.pop();
    if (!top || top.char !== closing[char]) return { command, changed: false };
    if (char === "}" && top.autoNormalize && top.controlStart !== undefined) {
      let next = index + 1;
      while (next < code.length && /\s/.test(code[next]!)) next += 1;
      if (code[next] === "|" && code[next + 1] !== "|") {
        insertions.push({ index: top.controlStart, text: "@(" }, { index: index + 1, text: ")" });
      }
    }
  }
  if (stack.length > 0 || insertions.length === 0) return { command, changed: false };
  let normalized = command;
  for (const insertion of insertions.sort((left, right) => right.index - left.index)) {
    normalized = `${normalized.slice(0, insertion.index)}${insertion.text}${normalized.slice(insertion.index)}`;
  }
  return { command: normalized, changed: normalized !== command };
}

function powershellPreflightError(command: string): string | undefined {
  const code = powershellCodeMask(command);
  const nestedCommandError = nestedPowerShellCommandExpansionError(command, code);
  if (nestedCommandError) return nestedCommandError;
  const rootScanError = driveRootRecursiveScanError(command, code);
  if (rootScanError) return rootScanError;
  const vaultScanError = vaultRootRecursiveScanError(command, code);
  if (vaultScanError) return vaultScanError;
  const tempScanError = tempRootRecursiveScanError(command, code);
  if (tempScanError) return tempScanError;
  const p3BuildWaitError = p3BuildSlotWaitError(command, code);
  if (p3BuildWaitError) return p3BuildWaitError;
  const swarmRouteError = swarmRouteDecisionIsolationError(command, code);
  if (swarmRouteError) return swarmRouteError;
  const productionMutationError = mcpProductionMutationError(command, code);
  if (productionMutationError) return productionMutationError;
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

function powershellWorker(): Worker {
  const testDelay = Math.max(0, Number(process.env.MCP_TEST_WORKER_CONSTRUCTION_DELAY_MS || 0));
  if (testDelay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, testDelay);
  const worker = new Worker(new URL("./process-launch-worker.js", import.meta.url), { workerData: { powershellExe: POWERSHELL_EXE } });
  worker.unref();
  return worker;
}

let sharedLauncherWorker: Worker | undefined;
let sharedLauncherFailure: string | undefined;
const sharedLauncherHandlers = new Map<string, (message: any) => void>();

function failSharedLauncher(message: string): void {
  if (sharedLauncherFailure) return;
  sharedLauncherFailure = message;
  emitTelemetry({ event: "process_launcher_worker_failed", error_message: message });
  const handlers = [...sharedLauncherHandlers.entries()];
  sharedLauncherHandlers.clear();
  for (const [requestId, handler] of handlers) handler({ requestId, type: "error", error: `process launcher unavailable: ${message}` });
}

function sharedPowerShellWorker(): Worker {
  if (sharedLauncherFailure) throw new Error(`process_launcher_unavailable: ${sharedLauncherFailure}`);
  if (sharedLauncherWorker) return sharedLauncherWorker;
  const worker = powershellWorker();
  worker.on("message", (message: any) => {
    if (!message || typeof message.requestId !== "string") return;
    sharedLauncherHandlers.get(message.requestId)?.(message);
  });
  worker.once("error", (error: Error) => failSharedLauncher(error.message));
  worker.once("exit", (code) => failSharedLauncher(`launcher worker exited with code ${code}`));
  worker.unref();
  sharedLauncherWorker = worker;
  return worker;
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

// These fields describe the completeness and integrity of retained MCP execution evidence.
// They do not score semantic task quality; output volume and exit status are evidence only.
function processOutputAudit(
  stdout: string,
  stderr: string,
  stdoutTruncated: boolean,
  stderrTruncated: boolean,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  error?: string,
  requestId?: string,
): Record<string, unknown> {
  const retainedStdoutBytes = Buffer.byteLength(stdout, "utf8");
  const retainedStderrBytes = Buffer.byteLength(stderr, "utf8");
  const executionOutcome = error
    ? "error"
    : signal
      ? "signaled"
      : exitCode === 0
        ? "success"
        : exitCode === null
          ? "unknown"
          : "nonzero_exit";
  return {
    ...(requestId ? { request_id: requestId } : {}),
    audit_schema: "process-output-evidence.v1",
    retained_stdout_chars: stdout.length,
    retained_stderr_chars: stderr.length,
    retained_output_chars: stdout.length + stderr.length,
    retained_stdout_bytes: retainedStdoutBytes,
    retained_stderr_bytes: retainedStderrBytes,
    retained_output_bytes: retainedStdoutBytes + retainedStderrBytes,
    stdout_sha256: createHash("sha256").update(stdout, "utf8").digest("hex"),
    stderr_sha256: createHash("sha256").update(stderr, "utf8").digest("hex"),
    evidence_completeness: stdoutTruncated || stderrTruncated ? "bounded" : "complete",
    execution_outcome: executionOutcome,
  };
}

export class ProcessManager {
  private readonly processes = new Map<string, ProcessState>();
  private readonly outputCursors = new Map<string, OutputCursor>();
  private readonly maxLivePerCaller: number;
  private readonly maxLiveTotal?: number;
  private readonly maxCompletedProcesses: number;
  private readonly receiptDirectory?: string;
  private readonly hostAdmissionDirectory?: string;
  private readonly hostAdmissionSlots = new Map<string, string>();
  private readonly receiptArchiveDirectory?: string;
  private readonly controlRequestDirectory?: string;
  private readonly controlResponseDirectory?: string;
  private readonly controlRequestsInFlight = new Set<string>();
  private readonly launcherWorker: Worker;
  private lastReceiptPruneAt = 0;
  private lastReceiptArchivePruneAt = 0;
  private lastControlPruneAt = 0;

  constructor(options: ProcessManagerOptions = {}) {
    this.maxLivePerCaller = options.maxLivePerCaller ?? DEFAULT_MAX_LIVE_PER_CALLER;
    this.maxLiveTotal = options.maxLiveTotal;
    if (this.maxLiveTotal !== undefined && (!Number.isInteger(this.maxLiveTotal) || this.maxLiveTotal < 1 || this.maxLiveTotal > MAX_CONFIGURED_LIVE_TOTAL)) {
      throw new Error(`maxLiveTotal must be an integer between 1 and ${MAX_CONFIGURED_LIVE_TOTAL}`);
    }
    this.maxCompletedProcesses = options.maxCompletedProcesses ?? MAX_COMPLETED_PROCESSES;
    this.launcherWorker = sharedPowerShellWorker();
    this.receiptDirectory = options.receiptDirectory ? resolve(options.receiptDirectory) : undefined;
    if (this.receiptDirectory) {
      mkdirSync(this.receiptDirectory, { recursive: true });
      if (this.maxLiveTotal !== undefined) {
        this.hostAdmissionDirectory = join(this.receiptDirectory, HOST_ADMISSION_DIRECTORY);
        mkdirSync(this.hostAdmissionDirectory, { recursive: true });
      }
      this.receiptArchiveDirectory = join(this.receiptDirectory, "archive");
      mkdirSync(this.receiptArchiveDirectory, { recursive: true });
      this.controlRequestDirectory = join(this.receiptDirectory, ".control", "requests");
      this.controlResponseDirectory = join(this.receiptDirectory, ".control", "responses");
      mkdirSync(this.controlRequestDirectory, { recursive: true });
      mkdirSync(this.controlResponseDirectory, { recursive: true });
      this.pruneReceipts();
      this.pruneControlFiles();
      const controlTimer = setInterval(() => { void this.sweepControlRequestsAsync(); }, CONTROL_POLL_MS);
      controlTimer.unref();
    }
  }

  private pidIsAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the PID exists but this process cannot signal it. Unknown probe
      // failures are also treated as live so admission fails closed instead of
      // reclaiming another backend's slot.
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private readHostAdmissionRecord(path: string): HostAdmissionRecord | undefined {
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as Partial<HostAdmissionRecord>;
      if (
        record.version !== 1 ||
        typeof record.process_id !== "string" ||
        !Number.isInteger(record.manager_pid) || Number(record.manager_pid) <= 0 ||
        (record.child_pid !== null && (!Number.isInteger(record.child_pid) || Number(record.child_pid) <= 0)) ||
        typeof record.claimed_at !== "string"
      ) return undefined;
      return record as HostAdmissionRecord;
    } catch {
      return undefined;
    }
  }

  private tryReclaimStaleHostAdmissionSlot(path: string): boolean {
    const record = this.readHostAdmissionRecord(path);
    if (!record) return false;
    if (this.pidIsAlive(record.manager_pid)) return false;
    if (record.child_pid !== null && this.pidIsAlive(record.child_pid)) return false;
    try {
      unlinkSync(path);
      emitTelemetry({ event: "process_host_admission_stale_slot_reclaimed", process_id: record.process_id, manager_pid: record.manager_pid, child_pid: record.child_pid });
      return true;
    } catch {
      return false;
    }
  }

  private rejectHostAdmission(callerId: string, ownerContext: TelemetryContext, liveCount: number, maxLiveTotal: number): never {
    emitTelemetry({
      event: "process_host_concurrency_rejected",
      owner_caller_id: callerId,
      live_process_count: liveCount,
      max_live_processes: maxLiveTotal,
    }, ownerContext);
    throw new Error(`start_process_host_concurrency_limited: shared MCP host already has ${liveCount} live process slots; max=${maxLiveTotal}; use read_output/kill_process on existing work before starting more`);
  }

  private claimHostAdmissionSlot(processId: string, callerId: string, claimedAt: string, ownerContext: TelemetryContext): void {
    const maxLiveTotal = this.maxLiveTotal;
    if (maxLiveTotal === undefined) return;
    if (!this.hostAdmissionDirectory) {
      const liveCount = this.liveProcessCount();
      if (liveCount >= maxLiveTotal) this.rejectHostAdmission(callerId, ownerContext, liveCount, maxLiveTotal);
      return;
    }

    const record: HostAdmissionRecord = { version: 1, process_id: processId, manager_pid: process.pid, child_pid: null, claimed_at: claimedAt };
    for (let index = 0; index < maxLiveTotal; index += 1) {
      const path = join(this.hostAdmissionDirectory, `${index}.json`);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          writeFileSync(path, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
          this.hostAdmissionSlots.set(processId, path);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST") {
            emitTelemetry({ event: "process_host_admission_error", owner_caller_id: callerId, error_message: error instanceof Error ? error.message : String(error) }, ownerContext);
            throw new Error(`start_process_host_admission_unavailable: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (attempt === 0 && this.tryReclaimStaleHostAdmissionSlot(path)) continue;
          break;
        }
      }
    }
    this.rejectHostAdmission(callerId, ownerContext, maxLiveTotal, maxLiveTotal);
  }

  private updateHostAdmissionChildPid(processId: string, childPid: number): void {
    const path = this.hostAdmissionSlots.get(processId);
    if (!path) return;
    const record = this.readHostAdmissionRecord(path);
    if (!record || record.process_id !== processId || record.manager_pid !== process.pid) return;
    try {
      writeFileSync(path, JSON.stringify({ ...record, child_pid: childPid }), { encoding: "utf8", flag: "w" });
    } catch (error) {
      emitTelemetry({ event: "process_host_admission_update_error", process_id: processId, child_pid: childPid, error_message: error instanceof Error ? error.message : String(error) });
    }
  }

  private releaseHostAdmissionSlot(processId: string): void {
    const path = this.hostAdmissionSlots.get(processId);
    if (!path) return;
    this.hostAdmissionSlots.delete(processId);
    const record = this.readHostAdmissionRecord(path);
    if (!record || record.process_id !== processId || record.manager_pid !== process.pid) return;
    try { unlinkSync(path); } catch { /* a concurrent stale-slot cleanup may already have removed it */ }
  }

  private observeTerminal(state: ProcessState, code: number | null, signal: NodeJS.Signals | null): void {
    if (state.terminalObserved) return;
    state.terminalObserved = true;
    const exitCode = code ?? -1;
    const finishedAt = new Date().toISOString();
    // Publish terminal state before receipt I/O. Under Windows hard paging,
    // receipt/archive writes can be delayed long after the child has exited.
    state.exitCode = exitCode;
    if (signal) state.signal = signal;
    state.finishedAt = finishedAt;
    state.launching = false;
    this.releaseHostAdmissionSlot(state.id);
    this.markProcessChanged(state);
    emitTelemetry({ event: "process_exit_observed", process_id: state.id, pid: state.pid, owner_caller_id: state.callerId, exit_code: state.exitCode, signal: state.signal ?? null, started_at: state.startedAt, finished_at: state.finishedAt }, state.ownerContext);
    sharedLauncherHandlers.delete(state.id);
    state.resolveDone();
    void this.persistReceiptAsync(state, exitCode, signal, finishedAt);
  }

  private handleLauncherMessage(message: any): void {
    if (!message || typeof message !== "object" || typeof message.requestId !== "string") return;
    const state = this.processes.get(message.requestId);
    if (!state || state.exitCode !== null) return;
    if (message.type === "started" && Number.isInteger(message.pid) && message.pid > 0) {
      state.pid = message.pid;
      state.launching = false;
      this.updateHostAdmissionChildPid(state.id, state.pid);
      emitTelemetry({ event: "process_started", process_id: state.id, pid: state.pid, owner_caller_id: state.callerId, cwd: state.cwd, started_at: state.startedAt }, state.ownerContext);
      if (state.killRequested) this.launcherWorker.postMessage({ type: "kill", requestId: state.id });
      return;
    }
    if (message.type === "stdout") { state.stdout.append(String(message.data ?? "")); this.markProcessChanged(state); return; }
    if (message.type === "stderr") { state.stderr.append(String(message.data ?? "")); this.markProcessChanged(state); return; }
    if (message.type === "error") {
      state.error = String(message.error ?? "process launcher worker failed");
      emitTelemetry({ event: "process_error", process_id: state.id, pid: state.pid, owner_caller_id: state.callerId, error_message: state.error }, state.ownerContext);
      this.observeTerminal(state, -1, null);
      return;
    }
    if (message.type === "exit") this.observeTerminal(state, typeof message.code === "number" ? message.code : -1, message.signal ?? null);
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

  private async persistArchivedReceiptAsync(receipt: CompletedProcessReceipt): Promise<void> {
    if (!this.receiptArchiveDirectory) return;
    const finishedMs = Date.parse(receipt.finished_at);
    if (!Number.isFinite(finishedMs)) return;
    const dayDirectory = join(this.receiptArchiveDirectory, new Date(finishedMs).toISOString().slice(0, 10));
    await mkdirAsync(dayDirectory, { recursive: true });
    const path = join(dayDirectory, `${receipt.process_id}.json`);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFileAsync(temporaryPath, JSON.stringify(receipt), { encoding: "utf8", flag: "wx" });
      try { await renameAsync(temporaryPath, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { try { await unlinkAsync(temporaryPath); } catch {} }
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

  private async persistPreflightRejectionAsync(rejectionId: string, command: string, workingDirectory: string | undefined, callerId: string, reason: string): Promise<void> {
    if (!this.receiptArchiveDirectory) return;
    const rejectedAt = new Date().toISOString();
    const dayDirectory = join(this.receiptArchiveDirectory, rejectedAt.slice(0, 10));
    await mkdirAsync(dayDirectory, { recursive: true });
    const path = join(dayDirectory, `rejected-${rejectionId}.json`);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const record = { version: 1, kind: "process_preflight_rejection", rejection_id: rejectionId, caller_id: callerId, command: command.slice(0, MAX_COMMAND_REPORT_CHARS), ...(command.length > MAX_COMMAND_REPORT_CHARS ? { command_truncated: true as const } : {}), working_directory: workingDirectory ?? null, reason, rejected_at: rejectedAt };
    try {
      await writeFileAsync(temporaryPath, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
      await renameAsync(temporaryPath, path);
    } catch (error) {
      emitTelemetry({ event: "process_preflight_rejection_archive_error", reason, error_message: error instanceof Error ? error.message : String(error) });
    } finally { try { await unlinkAsync(temporaryPath); } catch {} }
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
  private async writeControlFileAsync(path: string, value: ProcessControlRequest | ProcessControlResponse): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFileAsync(temporaryPath, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
      await renameAsync(temporaryPath, path);
    } finally { try { await unlinkAsync(temporaryPath); } catch {} }
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

  private async sweepControlRequestsAsync(): Promise<void> {
    if (!this.controlRequestDirectory || !this.controlResponseDirectory) return;
    let entries;
    try { entries = await readdirAsync(this.controlRequestDirectory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const requestPath = join(this.controlRequestDirectory, entry.name);
      let request: ProcessControlRequest;
      try { request = JSON.parse(await readFileAsync(requestPath, "utf8")) as ProcessControlRequest; } catch { continue; }
      if (request.version !== 1 || !PROCESS_ID_PATTERN.test(request.request_id) || !PROCESS_ID_PATTERN.test(request.process_id) || (request.action !== "read" && request.action !== "kill") || typeof request.requester_caller_id !== "string" || !Number.isFinite(Date.parse(request.deadline_at))) { try { await unlinkAsync(requestPath); } catch {}; continue; }
      if (Date.now() > Date.parse(request.deadline_at)) { try { await unlinkAsync(requestPath); } catch {}; continue; }
      if (!this.processes.has(request.process_id) || this.controlRequestsInFlight.has(request.request_id)) continue;
      this.controlRequestsInFlight.add(request.request_id);
      void this.handleControlRequest(request, requestPath).finally(() => this.controlRequestsInFlight.delete(request.request_id));
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
      await this.writeControlFileAsync(responsePath, response);
    } finally {
      try { await unlinkAsync(requestPath); } catch { /* requester may have timed out */ }
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
    await this.writeControlFileAsync(requestPath, request);
    emitTelemetry({
      event: "process_control_handoff_requested",
      process_id: processId,
      action,
      request_id: requestId,
    }, observer);
    try {
      while (Date.now() <= deadlineMs) {
        try {
          const response = JSON.parse(await readFileAsync(responsePath, "utf8")) as ProcessControlResponse;
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
          const receipt = await this.readReceiptAsync(processId, maxChars);
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
      try { await unlinkAsync(requestPath); } catch { /* owner may already have consumed it */ }
      try { await unlinkAsync(responsePath); } catch { /* response may not exist */ }
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
    const audit = processOutputAudit(stdout.text, stderr.text, stdout.truncated, stderr.truncated, state.exitCode, state.signal ?? null, state.error, state.ownerContext.request_id);
    const receipt: CompletedProcessReceipt = {
      version: 1,
      process_id: state.id,
      pid: state.pid,
      caller_id: state.callerId,
      ...audit,
      command,
      ...(state.command.length > MAX_COMMAND_REPORT_CHARS ? { command_truncated: true as const } : {}),
      ...(state.submittedCommand !== undefined ? { submitted_command: state.submittedCommand.slice(0, MAX_COMMAND_REPORT_CHARS), ...(state.submittedCommand.length > MAX_COMMAND_REPORT_CHARS ? { submitted_command_truncated: true as const } : {}) } : {}),
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
        ...audit,
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

  private async persistReceiptAsync(state: ProcessState, exitCode: number, signal: NodeJS.Signals | null, finishedAt: string): Promise<void> {
    const path = this.receiptPath(state.id);
    if (!path) return;
    const command = state.command.slice(0, MAX_COMMAND_REPORT_CHARS);
    const stdout = state.stdout.tail(MAX_CAPTURE_CHARS, MAX_CAPTURE_CHARS);
    const stderr = state.stderr.tail(MAX_CAPTURE_CHARS, MAX_CAPTURE_CHARS);
    const audit = processOutputAudit(stdout.text, stderr.text, stdout.truncated, stderr.truncated, exitCode, signal, state.error, state.ownerContext.request_id);
    const receipt: CompletedProcessReceipt = { version: 1, process_id: state.id, pid: state.pid, caller_id: state.callerId, ...audit, command, ...(state.command.length > MAX_COMMAND_REPORT_CHARS ? { command_truncated: true as const } : {}), ...(state.submittedCommand !== undefined ? { submitted_command: state.submittedCommand.slice(0, MAX_COMMAND_REPORT_CHARS), ...(state.submittedCommand.length > MAX_COMMAND_REPORT_CHARS ? { submitted_command_truncated: true as const } : {}) } : {}), cwd: state.cwd, stdout: stdout.text, stderr: stderr.text, ...(stdout.truncated ? { stdout_truncated: true as const } : {}), ...(stderr.truncated ? { stderr_truncated: true as const } : {}), exit_code: exitCode, signal, started_at: state.startedAt, finished_at: finishedAt, ...(state.error ? { error: state.error } : {}) };
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFileAsync(temporaryPath, JSON.stringify(receipt), { encoding: "utf8", flag: "wx" });
      await renameAsync(temporaryPath, path);
      await this.persistArchivedReceiptAsync(receipt);
      emitTelemetry({ event: "process_receipt_persisted", process_id: state.id, pid: state.pid, owner_caller_id: state.callerId, ...audit }, state.ownerContext);
    } catch (error) { emitTelemetry({ event: "process_receipt_error", process_id: state.id, pid: state.pid, owner_caller_id: state.callerId, error_message: error instanceof Error ? error.message : String(error) }, state.ownerContext); }
    finally { try { await unlinkAsync(temporaryPath); } catch {} }
  }

  private formatReceipt(receipt: CompletedProcessReceipt, processId: string, maxChars: number): Record<string, unknown> | undefined {
    if (receipt.version !== 1 || receipt.process_id !== processId || typeof receipt.pid !== "number" || typeof receipt.command !== "string" || typeof receipt.cwd !== "string" || typeof receipt.stdout !== "string" || typeof receipt.stderr !== "string" || typeof receipt.started_at !== "string" || typeof receipt.finished_at !== "string") return undefined;
    const limit = Math.max(1, Math.min(maxChars, MAX_READ_CHARS));
    const observer = currentTelemetryContext();
    const observerCallerId = observer.caller_id ?? "caller_unknown";
    emitTelemetry({ event: "process_receipt_read", process_id: receipt.process_id, pid: receipt.pid, owner_caller_id: receipt.caller_id, caller_id: observerCallerId }, observer);
    const audit = processOutputAudit(receipt.stdout, receipt.stderr, Boolean(receipt.stdout_truncated), Boolean(receipt.stderr_truncated), receipt.exit_code, receipt.signal, receipt.error, receipt.request_id);
    const legacy = { ...processResponseState(receipt.started_at, false, receipt.finished_at), process_id: receipt.process_id, pid: receipt.pid, ...audit, command: receipt.command, ...(receipt.command_truncated ? { command_truncated: true } : {}), ...(receipt.submitted_command !== undefined ? { submitted_command: receipt.submitted_command, ...(receipt.submitted_command_truncated ? { submitted_command_truncated: true } : {}) } : {}), cwd: receipt.cwd, running: false, stdout: receipt.stdout.slice(-limit), stderr: receipt.stderr.slice(-limit), exit_code: receipt.exit_code, signal: receipt.signal, started_at: receipt.started_at, finished_at: receipt.finished_at, ...(receipt.stdout_truncated || receipt.stdout.length > limit ? { stdout_truncated: true } : {}), ...(receipt.stderr_truncated || receipt.stderr.length > limit ? { stderr_truncated: true } : {}), ...(receipt.error ? { error: receipt.error } : {}) };
    const cursorExists = this.outputCursors.has(this.cursorKey(receipt.process_id, observerCallerId));
    const needsPaging = cursorExists || receipt.stdout.length + receipt.stderr.length > limit;
    return needsPaging ? this.pageOutput(legacy, receipt.stdout, receipt.stderr, observerCallerId, Boolean(receipt.stdout_truncated), Boolean(receipt.stderr_truncated), limit) : legacy;
  }

  private readReceipt(processId: string, maxChars: number): Record<string, unknown> | undefined {
    this.pruneReceipts();
    for (const path of this.receiptReadPaths(processId)) {
      try { return this.formatReceipt(JSON.parse(readFileSync(path, "utf8")) as CompletedProcessReceipt, processId, maxChars); } catch {}
    }
    return undefined;
  }

  private async readReceiptAsync(processId: string, maxChars: number): Promise<Record<string, unknown> | undefined> {
    for (const path of this.receiptReadPaths(processId)) {
      try { return this.formatReceipt(JSON.parse(await readFileAsync(path, "utf8")) as CompletedProcessReceipt, processId, maxChars); } catch {}
    }
    return undefined;
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

  start(command: string, workingDirectory?: string, callerId = "caller_unknown"): { mcp_status: "OK"; process_state: "RUNNING" | "COMPLETED"; elapsed_ms: number; next_action: "READ_SAME_PROCESS_ID" | "STOP_READING"; process_id: string; pid: number; cwd: string; running: boolean; launching?: boolean } {
    this.pruneCompleted();
    const normalization = normalizePowerShellControlStatementPipelines(command);
    const effectiveCommand = normalization.command;
    const preflightError = powershellPreflightError(effectiveCommand);
    if (preflightError) {
      const rejectionId = randomUUID();
      void this.persistPreflightRejectionAsync(rejectionId, command, workingDirectory, callerId, preflightError);
      emitTelemetry({ event: "process_preflight_rejected", reason: preflightError, rejection_id: rejectionId });
      throw new Error(`start_process_preflight_failed: ${preflightError}`);
    }
    const cwd = normalizedCwd(workingDirectory);
    const duplicate = [...this.processes.values()].find((state) => state.exitCode === null && state.callerId === callerId && state.cwd === cwd && state.command === effectiveCommand);
    if (duplicate) {
      emitTelemetry({ event: "process_reused", process_id: duplicate.id, pid: duplicate.pid, owner_caller_id: duplicate.callerId });
      return { ...processResponseState(duplicate.startedAt, true), process_id: duplicate.id, pid: duplicate.pid, cwd: duplicate.cwd, running: true, ...(duplicate.launching ? { launching: true } : {}) } as const;
    }
    const liveForCaller = [...this.processes.values()].filter((state) => state.exitCode === null && state.callerId === callerId);
    if (liveForCaller.length >= this.maxLivePerCaller) throw new Error(`start_process_concurrency_limited: caller already has ${liveForCaller.length} live processes; active_process_ids=${liveForCaller.map((state) => state.id).join(",")}`);
    const ownerContext = currentTelemetryContext();
    if (sharedLauncherFailure) throw new Error(`process_launcher_unavailable: ${sharedLauncherFailure}`);
    const processId = randomUUID();
    const startedAt = new Date().toISOString();
    this.claimHostAdmissionSlot(processId, callerId, startedAt, ownerContext);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const state: ProcessState = {
      id: processId, pid: 0, callerId, ownerContext, command: effectiveCommand, ...(normalization.changed ? { submittedCommand: command } : {}), cwd,
      launching: true, terminalObserved: false, resolveDone, killRequested: false,
      stdout: new BoundedCapture(), stderr: new BoundedCapture(), startedAt, exitCode: null,
      done, revision: 0, lastReadRevisionByCaller: new Map<string, number>(), waiters: new Set<() => void>(),
    };
    this.processes.set(state.id, state);
    sharedLauncherHandlers.set(state.id, (message) => this.handleLauncherMessage(message));
    try {
      this.launcherWorker.postMessage({ type: "launch", requestId: state.id, command: effectiveCommand, cwd });
    } catch (error) {
      sharedLauncherHandlers.delete(state.id);
      this.processes.delete(state.id);
      this.releaseHostAdmissionSlot(state.id);
      throw error;
    }
    if (normalization.changed) emitTelemetry({ event: "process_command_normalized", process_id: state.id, rewrite: "control_statement_pipeline_capture" }, state.ownerContext);
    emitTelemetry({ event: "process_launch_queued", process_id: state.id, owner_caller_id: state.callerId, cwd: state.cwd, started_at: state.startedAt }, state.ownerContext);
    return { ...processResponseState(state.startedAt, true), process_id: state.id, pid: 0, cwd: state.cwd, running: true, launching: true } as const;
  }

  async startWithWait(
    command: string,
    workingDirectory?: string,
    callerId = "caller_unknown",
    waitMs = 750,
  ): Promise<Record<string, unknown>> {
    const cwd = await boundedValidatedCwd(workingDirectory);
    const started = this.start(command, cwd, callerId);
    const boundedWaitMs = Math.max(0, Math.min(waitMs, 10_000));
    emitTelemetry({
      event: "process_wait_requested",
      action: "start",
      process_id: started.process_id,
      requested_wait_ms: boundedWaitMs,
    });
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
      ...(state.submittedCommand !== undefined ? { submitted_command: state.submittedCommand.slice(0, MAX_COMMAND_REPORT_CHARS), ...(state.submittedCommand.length > MAX_COMMAND_REPORT_CHARS ? { submitted_command_truncated: true } : {}) } : {}),
      cwd: state.cwd,
      running: state.exitCode === null,
      ...(state.launching ? { launching: true } : {}),
      stdout: stdout.text,
      stderr: stderr.text,
      ...(state.exitCode !== null ? processOutputAudit(fullStdout.text, fullStderr.text, fullStdout.truncated, fullStderr.truncated, state.exitCode, state.signal ?? null, state.error, state.ownerContext.request_id) : {}),
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
    emitTelemetry({
      event: "process_wait_requested",
      action: "read",
      process_id: processId,
      requested_wait_ms: boundedWaitMs,
    });
    const state = this.processes.get(processId);
    if (!state) {
      const receipt = await this.readReceiptAsync(processId, maxChars);
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
        ...(state.launching ? { launching: true } : {}),
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
      const receipt = await this.readReceiptAsync(processId, MAX_READ_CHARS);
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
    if (state.exitCode === null && isProtectedControlPlaneProcessCommand(state.command)) {
      emitTelemetry({
        event: "process_kill_rejected",
        process_id: state.id,
        pid: state.pid,
        owner_caller_id: state.callerId,
        caller_id: observer.caller_id ?? "caller_unknown",
        reason: "protected_control_plane",
      }, observer);
      throw new Error(PROTECTED_CONTROL_PLANE_TERMINATION_ERROR);
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
    state.killRequested = true;
    this.launcherWorker.postMessage({ type: "kill", requestId: state.id });
    await Promise.race([state.done, delay(TASKKILL_TIMEOUT_MS + KILL_SETTLE_MS)]);
    if (state.exitCode === null) {
      emitTelemetry({
        event: "process_kill_incomplete",
        process_id: state.id,
        pid: state.pid,
        owner_caller_id: state.callerId,
        caller_id: observer.caller_id ?? "caller_unknown",
        kill_timed_out: true,
      }, observer);
      return {
        process_id: state.id,
        pid: state.pid,
        killed: false,
        kill_requested: true,
        running: true,
        kill_timed_out: true,
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

  liveProcessCount(): number {
    let count = 0;
    for (const state of this.processes.values()) if (state.exitCode === null) count += 1;
    return count;
  }

  hasLiveScope(scope: string): boolean {
    const candidate = scope.startsWith("process:") ? scope.slice("process:".length) : scope;
    const state = this.processes.get(candidate);
    return Boolean(state && state.exitCode === null);
  }

}
