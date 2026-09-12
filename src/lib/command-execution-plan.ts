export type CommandExecutionMode = "powershell" | "native" | "explicit_shell" | "native_sequence";
export type CommandRunCondition = "always" | "success" | "failure";

export type CommandExecutionStep = {
  executable: string;
  args: string[];
  runIf: CommandRunCondition;
  reason: string;
  stdin?: string;
};

export type CommandExecutionPlan = {
  mode: CommandExecutionMode;
  executable: string;
  args: string[];
  reason: string;
  stdin?: string;
  steps?: CommandExecutionStep[];
};

type ParsedWords = { words: string[]; hasTopLevelShellSyntax: boolean; hasPowerShellExpansion: boolean };
type SequencePart = { command: string; runIf: CommandRunCondition };

const NATIVE_COMMANDS = new Set([
  "git", "git.exe", "gh", "gh.exe", "rg", "rg.exe", "ripgrep", "ripgrep.exe",
  "python", "python.exe", "python3", "python3.exe", "py", "py.exe", "node", "node.exe",
  "npm", "npm.cmd", "npx", "npx.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd",
  "uv", "uv.exe", "curl", "curl.exe", "adb", "adb.exe", "dotnet", "dotnet.exe",
  "cmake", "cmake.exe", "ninja", "ninja.exe", "pytest", "pytest.exe", "ssh", "ssh.exe",
  "scp", "scp.exe", "sftp", "sftp.exe", "where", "where.exe", "findstr", "findstr.exe",
  "netstat", "netstat.exe", "ipconfig", "ipconfig.exe", "tasklist", "tasklist.exe",
  "robocopy", "robocopy.exe", "java", "java.exe", "javac", "javac.exe",
]);

const EXPLICIT_SHELLS = new Set([
  "pwsh", "pwsh.exe", "powershell", "powershell.exe", "cmd", "cmd.exe",
  "bash", "bash.exe", "sh", "sh.exe", "wsl", "wsl.exe",
]);

function basenameLower(value: string): string {
  const normalized = value.replaceAll("/", "\\");
  return normalized.slice(normalized.lastIndexOf("\\") + 1).toLowerCase();
}

function parseWords(command: string): ParsedWords | undefined {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  let hasTopLevelShellSyntax = false;
  let hasPowerShellExpansion = false;
  const flush = () => {
    if (!started) return;
    words.push(current);
    current = "";
    started = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      // Generated native CLI commands frequently use JSON/C-style escaped quotes even
      // though PowerShell itself would not. Once we own argv construction, preserve the
      // intended literal quote instead of feeding the malformed string to a shell.
      if (quote === '"' && char === "\\" && command[index + 1] === '"') {
        current += '"';
        started = true;
        index += 1;
        continue;
      }
      if (char === quote) {
        if (quote === "'" && command[index + 1] === "'") {
          current += "'";
          started = true;
          index += 1;
          continue;
        }
        quote = undefined;
        started = true;
        continue;
      }
      if (quote === '"' && char === '$') hasPowerShellExpansion = true;
      current += char;
      started = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\r" || char === "\n") {
      hasTopLevelShellSyntax = true;
      flush();
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (";|&<>".includes(char)) hasTopLevelShellSyntax = true;
    if (char === '$' || char === '`') hasPowerShellExpansion = true;
    current += char;
    started = true;
  }
  if (quote) return undefined;
  flush();
  return { words, hasTopLevelShellSyntax, hasPowerShellExpansion };
}

function explicitShellExecutable(first: string, powershellExe: string, env: NodeJS.ProcessEnv): string {
  const base = basenameLower(first);
  if (base === "pwsh" || base === "pwsh.exe") return powershellExe;
  if (base === "powershell" || base === "powershell.exe") return `${env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  if (base === "cmd" || base === "cmd.exe") return env.ComSpec || `${env.SystemRoot || "C:\\Windows"}\\System32\\cmd.exe`;
  return first;
}

function isPathExecutable(first: string): boolean {
  return /(?:^|[\\/])[^\\/]+\.(?:exe|com|cmd|bat)$/i.test(first);
}

function shouldDirectExplicitShell(command: string, base: string, parsed: ParsedWords): boolean {
  if (!EXPLICIT_SHELLS.has(base)) return false;
  if (!parsed.hasTopLevelShellSyntax) return true;
  if (base !== "cmd" && base !== "cmd.exe") return false;
  const match = /^\s*(?:cmd|cmd\.exe)\s+(?:(?:\/[dqsuaefv](?::(?:on|off))?)\s+)*\/c\s+([\s\S]+)$/i.exec(command);
  const payload = match?.[1]?.trim() ?? "";
  if (/(^|[^`])</.test(payload) || /\bfor\s+%[A-Za-z]/i.test(payload) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(payload)) return true;
  // `cmd /c "... && ..."` explicitly delegates a complete command program to cmd.exe.
  // Keeping it under an outer PowerShell is double parsing and was a recurring failure source.
  return payload.length >= 2 && payload.startsWith('"') && payload.endsWith('"') && /&&|\|\|/.test(payload);
}

function pythonHeredocPlan(command: string): CommandExecutionPlan | undefined {
  // LLMs frequently emit POSIX `python - <<'PY'` even on Windows. Treat the heredoc as
  // process stdin, matching Execa/zx input semantics, instead of asking PowerShell to parse it.
  const match = /^\s*((?:python(?:3)?|py)(?:\.exe)?)\s+([^\r\n]*?)<<\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\3\s*\r?\n([\s\S]*?)\r?\n\4\s*$/i.exec(command);
  if (!match) return undefined;
  const prefix = `${match[1]} ${match[2]}`.trim();
  const parsed = parseWords(prefix);
  if (!parsed || parsed.words.length === 0 || parsed.hasTopLevelShellSyntax || parsed.hasPowerShellExpansion) return undefined;
  const [executable, ...args] = parsed.words;
  const stdin = `${match[5]}\n`;
  return { mode: "native", executable: executable!, args, stdin, reason: "python_heredoc_to_stdin" };
}

function splitTopLevelSequence(command: string): SequencePart[] | undefined {
  const parts: SequencePart[] = [];
  let start = 0;
  let nextRunIf: CommandRunCondition = "always";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let sawSeparator = false;

  const push = (end: number, runIfForNext: CommandRunCondition) => {
    const segment = command.slice(start, end).trim();
    if (!segment) return false;
    parts.push({ command: segment, runIf: nextRunIf });
    nextRunIf = runIfForNext;
    sawSeparator = true;
    return true;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '`' && quote === '"') { escaped = true; continue; }
      if (char === quote) {
        if (quote === "'" && command[index + 1] === "'") { index += 1; continue; }
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '`') { escaped = true; continue; }
    if (char === '&' && command[index + 1] === '&') {
      if (!push(index, "success")) return undefined;
      index += 1;
      start = index + 1;
      continue;
    }
    if (char === '|' && command[index + 1] === '|') {
      if (!push(index, "failure")) return undefined;
      index += 1;
      start = index + 1;
      continue;
    }
    if (char === ';') {
      if (!push(index, "always")) return undefined;
      start = index + 1;
      continue;
    }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && command[index + 1] === '\n') index += 1;
      if (!command.slice(start, index).trim()) { start = index + 1; continue; }
      if (!push(index, "always")) return undefined;
      start = index + 1;
      continue;
    }
    // A single pipe/background operator requires real shell semantics. Do not emulate it.
    if (char === '|' || char === '&') return undefined;
  }
  if (quote || escaped) return undefined;
  const tail = command.slice(start).trim();
  if (tail) parts.push({ command: tail, runIf: nextRunIf });
  return sawSeparator && parts.length > 1 ? parts : undefined;
}

function powershellPlan(command: string, powershellExe: string, reason: string): CommandExecutionPlan {
  return { mode: "powershell", executable: powershellExe, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", command], reason };
}

/** Build an execution plan from already-structured executable/argv input. No shell parsing. */
export function planStructuredExecution(
  executable: string,
  args: string[] = [],
  stdin: string | undefined = undefined,
  powershellExe: string,
  env: NodeJS.ProcessEnv = process.env,
): CommandExecutionPlan {
  const base = basenameLower(executable);
  const explicit = EXPLICIT_SHELLS.has(base);
  return {
    mode: explicit ? "explicit_shell" : "native",
    executable: explicit ? explicitShellExecutable(executable, powershellExe, env) : executable,
    args: [...args],
    ...(stdin !== undefined ? { stdin } : {}),
    reason: explicit ? "structured_explicit_shell" : "structured_argv",
  };
}

function planSingleCommand(command: string, powershellExe: string, env: NodeJS.ProcessEnv): CommandExecutionPlan {
  const heredoc = pythonHeredocPlan(command);
  if (heredoc) return heredoc;

  const trimmed = command.trimStart();
  const callOperatorMatch = /^&\s+/.exec(trimmed);
  const argvSource = callOperatorMatch ? trimmed.slice(callOperatorMatch[0].length) : command;
  const parsed = parseWords(argvSource);
  if (!parsed || parsed.words.length === 0) return powershellPlan(command, powershellExe, "powershell_unparsed");

  const [first, ...args] = parsed.words;
  const base = basenameLower(first!);
  if (shouldDirectExplicitShell(argvSource, base, parsed)) {
    return { mode: "explicit_shell", executable: explicitShellExecutable(first!, powershellExe, env), args, reason: "explicit_shell_direct" };
  }

  const nativeCandidate = NATIVE_COMMANDS.has(base) || isPathExecutable(first!);
  if (nativeCandidate && !parsed.hasTopLevelShellSyntax && !parsed.hasPowerShellExpansion) {
    return { mode: "native", executable: first!, args, reason: callOperatorMatch ? "powershell_call_operator_native_argv" : "native_argv_direct" };
  }

  return powershellPlan(command, powershellExe, parsed.hasTopLevelShellSyntax ? "powershell_shell_syntax" : parsed.hasPowerShellExpansion ? "powershell_expansion" : "powershell_command");
}

/**
 * Execa-style execution planning for the legacy string API.
 *
 * The default is executable+argv without a shell. Explicit nested shells are spawned
 * directly. Simple `;`, `&&`, and `||` programs composed only of native commands are
 * executed as a process sequence in the worker. PowerShell is the fallback only when
 * the command genuinely needs PowerShell syntax or expansion.
 *
 * This is routing, not a security boundary. Policy/safety preflight remains independent
 * and is evaluated against the original command before any process is launched.
 */
export function planCommandExecution(command: string, powershellExe: string, env: NodeJS.ProcessEnv = process.env): CommandExecutionPlan {
  const heredoc = pythonHeredocPlan(command);
  if (heredoc) return heredoc;

  const sequence = splitTopLevelSequence(command);
  if (sequence) {
    const steps: CommandExecutionStep[] = [];
    for (const part of sequence) {
      const plan = planSingleCommand(part.command, powershellExe, env);
      if (plan.mode === "powershell" || plan.mode === "native_sequence" || plan.steps) {
        return planSingleCommand(command, powershellExe, env);
      }
      steps.push({ executable: plan.executable, args: plan.args, runIf: part.runIf, reason: plan.reason, ...(plan.stdin !== undefined ? { stdin: plan.stdin } : {}) });
    }
    const first = steps[0]!;
    return { mode: "native_sequence", executable: first.executable, args: first.args, reason: "native_sequence", steps };
  }

  return planSingleCommand(command, powershellExe, env);
}
