import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager();

async function run(command, caller) {
  const result = await manager.startWithWait(command, undefined, caller, 5_000);
  assert.equal(result.running, false, JSON.stringify(result));
  return result;
}

function rejects(command, expected) {
  assert.throws(
    () => manager.start(command, undefined, "caller_pwsh_preflight_reject"),
    (error) => error instanceof Error && error.message.startsWith("start_process_preflight_failed:") && expected.test(error.message),
  );
}

const valid = await run("$values = @(foreach ($x in 1,2) { $x }); $values | Measure-Object | Select-Object -ExpandProperty Count", "caller_pwsh_preflight_valid");
assert.equal(valid.exit_code, 0, JSON.stringify(valid));
assert.match(valid.stdout, /2/);

const nativeFailure = await run("cmd.exe /c exit 7", "caller_pwsh_preflight_native_failure");
assert.equal(nativeFailure.exit_code, 1, "guard must preserve powershell.exe -Command failure semantics");
const explicitExit = await run("exit 42", "caller_pwsh_preflight_explicit_exit");
assert.equal(explicitExit.exit_code, 42, "explicit PowerShell exit codes must pass through");

const runtime = await run("Write-Output $PSVersionTable.PSEdition; Write-Output $PSVersionTable.PSVersion.ToString(); Write-Output (Get-Process -Id $PID).Path", "caller_pwsh_runtime");
assert.match(runtime.stdout, /Core/);
assert.match(runtime.stdout, /7\.6\.5/);
assert.match(runtime.stdout, /C:\\Program Files\\PowerShell\\7\\pwsh\.exe/i);

const operators = await run("cmd.exe /c exit 0 && Write-Output AND_OK; cmd.exe /c exit 1 || Write-Output OR_OK; $value = $null ?? 'NULL_OK'; Write-Output $value", "caller_pwsh_operators");
assert.match(operators.stdout, /AND_OK/);
assert.match(operators.stdout, /OR_OK/);
assert.match(operators.stdout, /NULL_OK/);

rejects("$PID = 123", /automatic/);
rejects("$PID++", /automatic/);
rejects("$args = @('bad')", /automatic/);
rejects("foreach ($x in 1) { $x } | Out-Null", /capture/);
rejects("if ($true) { Write-Output 'broken'", /unbalanced/);
rejects("Get-ChildItem C:\\ -Recurse", /drive[- ]root/);
rejects("gci -r 'D:\\'", /drive[- ]root/);
rejects("dir -Path C:/ -Recurse", /drive[- ]root/);
rejects("rg needle C:\\", /drive[- ]root/);
rejects("where.exe /R C:\\ *.txt", /drive[- ]root/);
rejects("findstr.exe /S needle C:\\*", /drive[- ]root/);
rejects("cmd.exe /c dir C:\\ /s", /drive[- ]root/);
rejects("tree.exe C:\\ /F", /drive[- ]root/);
rejects("$pidToWait=20052; if(Get-Process -Id $pidToWait -ErrorAction SilentlyContinue){'WAIT_FOREIGN_UBT='+$pidToWait; Wait-Process -Id $pidToWait}; 'FOREIGN_UBT_EXITED'", /P3 build-slot waits/);
rejects("$lane='C:\\work'; $ownerPid=20052; while((Get-Date)-lt (Get-Date).AddMinutes(15)){if(-not (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)){break}; Start-Sleep -Milliseconds 200}; & (Join-Path $lane 'scripts\\Invoke-P3Build.ps1') -ProjectRoot $lane -Target Editor", /P3 build-slot polling/);
rejects("Wait-Process -Id 20052; & 'C:\\work\\scripts\\Invoke-P3HotSourceBuild.ps1' -Module P3Gameplay", /P3 build-slot waits/);

const ordinaryWait = await run("Wait-Process -Id 2147483647 -ErrorAction SilentlyContinue; Write-Output 'ORDINARY_WAIT_ALLOWED'", "caller_ordinary_wait_allowed");
assert.match(ordinaryWait.stdout, /ORDINARY_WAIT_ALLOWED/);

const boundedRoot = mkdtempSync(join(tmpdir(), "mcp-bounded-recursion-"));
try {
  const bounded = await run(`Get-ChildItem -LiteralPath '${boundedRoot.replaceAll("'", "''")}' -Recurse | Measure-Object | Select-Object -ExpandProperty Count`, "caller_bounded_recursion");
  assert.equal(bounded.exit_code, 0, JSON.stringify(bounded));
} finally {
  rmSync(boundedRoot, { recursive: true, force: true });
}

// Guard text inside strings/comments/here-strings must not become false positives.
const literals = await run("$text='&& $PID = 1'; # || $args = 2\n$here=@'\nforeach ($x in 1) { $x } | Out-Null\n'@\nWrite-Output $text; Write-Output $here", "caller_pwsh_preflight_literals");
assert.equal(literals.exit_code, 0, JSON.stringify(literals));
assert.match(literals.stdout, /&& \$PID = 1/);


const rejectionReceiptDirectory = mkdtempSync(join(tmpdir(), "mcp-preflight-rejection-"));
try {
  const durableManager = new ProcessManager({ receiptDirectory: rejectionReceiptDirectory });
  assert.throws(
    () => durableManager.start("$PID = 123", "C:\\Users\\Example", "caller_durable_preflight_reject"),
    /start_process_preflight_failed:/,
  );
  const day = new Date().toISOString().slice(0, 10);
  const dayDirectory = join(rejectionReceiptDirectory, "archive", day);
  const files = readdirSync(dayDirectory).filter((name) => name.startsWith("rejected-") && name.endsWith(".json"));
  assert.equal(files.length, 1, JSON.stringify(files));
  const rejection = JSON.parse(readFileSync(join(dayDirectory, files[0]), "utf8"));
  assert.equal(rejection.kind, "process_preflight_rejection");
  assert.equal(rejection.caller_id, "caller_durable_preflight_reject");
  assert.equal(rejection.command, "$PID = 123");
  assert.match(rejection.reason, /automatic/);
  assert.ok(rejection.rejection_id);
} finally {
  rmSync(rejectionReceiptDirectory, { recursive: true, force: true });
}

console.log("PASS powershell_preflight pwsh=7.6.5 ps7_operators=true drive_root_recursion=blocked bounded_recursion=allowed durable_rejections=true");
