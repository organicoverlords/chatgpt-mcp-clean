// Transport-only compatibility with the pre-Rust structured process runner.
// No command policy, routing, scheduler, or stack lifecycle logic belongs here.
import { basename } from "node:path";
export type StructuredInvocation = {
  executable: string; args: string[]; stdin?: string;
  execution_mode: "native" | "explicit_shell" | "powershell";
  execution_reason: string;
};
const powershellRuntime = process.env.MCP_POWERSHELL_EXE?.trim() || (process.platform === "win32" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : "pwsh");
const shells = new Set(["pwsh", "pwsh.exe", "powershell", "powershell.exe", "cmd", "cmd.exe", "bash", "bash.exe", "sh", "sh.exe", "wsl", "wsl.exe"]);
export function structuredInvocation(executable: string, args: string[], stdin?: string): StructuredInvocation {
  const name = basename(executable.replaceAll("\\", "/")).toLowerCase();
  const shell = shells.has(name);
  // Windows command shims cannot preserve multiline arguments; reject explicitly.
  if (process.platform === "win32" && (/\.(?:cmd|bat)$/.test(name) || ["npm", "npx", "pnpm", "yarn"].includes(name)) && args.some(arg => /[\r\n]/.test(arg))) {
    throw new Error("windows_command_shim_multiline_argument_not_lossless: use script/language or a native executable");
  }
  const resolvedExecutable = process.platform === "win32" && ["pwsh", "pwsh.exe"].includes(name) && !/[\\/]/.test(executable) ? powershellRuntime : executable;
  return { executable: resolvedExecutable, args: [...args], ...(stdin !== undefined ? { stdin } : {}), execution_mode: shell ? "explicit_shell" : "native", execution_reason: shell ? "structured_explicit_shell" : "structured_argv" };
}
export function scriptInvocation(language: string, script: string): StructuredInvocation {
  if (language === "powershell") return {
    executable: powershellRuntime,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", ...(process.platform === "win32" ? ["-WindowStyle", "Hidden"] : []), "-Command", "$encoding=[Text.UTF8Encoding]::new($false); [Console]::InputEncoding=$encoding; [Console]::OutputEncoding=$encoding; $OutputEncoding=$encoding; $source=[Console]::In.ReadToEnd(); try { $block=[scriptblock]::Create($source) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }; & $block"],
    stdin: script, execution_mode: "powershell", execution_reason: "structured_script_powershell_stdin_scriptblock",
  };
  if (language === "python") return { executable: process.platform === "win32" ? "python.exe" : "python3", args: ["-"], stdin: script, execution_mode: "native", execution_reason: "structured_script_python_stdin" };
  if (language === "node") return { executable: process.execPath, args: ["-"], stdin: script, execution_mode: "native", execution_reason: "structured_script_node_stdin" };
  if (language === "bash") return { executable: "bash", args: ["-s"], stdin: script, execution_mode: "explicit_shell", execution_reason: "structured_script_bash_stdin" };
  throw new Error("unsupported script language: " + language);
}
