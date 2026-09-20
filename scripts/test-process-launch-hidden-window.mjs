import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ProcessManager } from "../dist/lib/process-manager.js";

const source = readFileSync(new URL("../src/lib/process-launch-worker.ts", import.meta.url), "utf8");
const plannerSource = readFileSync(new URL("../src/lib/command-execution-plan.ts", import.meta.url), "utf8");
assert.doesNotMatch(plannerSource, /"-WindowStyle"|"-ExecutionPolicy"|\bBypass\b/, "ordinary PowerShell plans must not request hidden WindowStyle or bypass execution policy");
assert.match(source, /windowsHide:\s*true/, "launcher must retain native hidden-window spawn flag");
assert.match(source, /MCP_POWERSHELL_STARTUP_TIMEOUT_MS/, "launcher must bound PowerShell startup stalls");
assert.match(source, /__MCP_POWERSHELL_READY_/, "launcher must require an internal PowerShell execution-ready handshake");
assert.match(source, /requestKill\(requestId\)/, "startup timeout must kill the owned process tree");
const manager = new ProcessManager();
const started = manager.start("$p=[Diagnostics.Process]::GetCurrentProcess(); Write-Output ('MAIN_WINDOW_HANDLE='+$p.MainWindowHandle); Start-Sleep -Milliseconds 700", undefined, "caller_hidden_window_probe");
let result = started;
for (let i=0;i<20 && result.running!==false;i++) result = await manager.readWithWait(started.process_id, 32000, 250);
assert.equal(result.exit_code, 0);
assert.match(result.stdout, /MAIN_WINDOW_HANDLE=0\b/, "PowerShell child exposed a visible main window handle");
console.log("PASS process_launch_hidden_window cli_windowstyle_hidden=false executionpolicy_bypass=false windowsHide=true startup_handshake=true main_window_handle=0");
