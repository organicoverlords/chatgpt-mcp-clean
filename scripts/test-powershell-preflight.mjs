import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager();
const commandWaitMs = 30_000;
assert.ok(process.env.USERPROFILE, "USERPROFILE is required for Vault-root preflight test");
const vaultRoot = join(process.env.USERPROFILE, "Desktop", "vault");
const psQuote = (value) => value.replaceAll("'", "''");

async function run(command, caller) {
  const result = await manager.startWithWait(command, undefined, caller, commandWaitMs);
  assert.equal(result.running, false, `command did not finish within ${commandWaitMs} ms: ${JSON.stringify(result)}`);
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
assert.equal(nativeFailure.exit_code, 7, "explicit cmd.exe must execute directly and preserve its native exit code");
const explicitExit = await run("exit 42", "caller_pwsh_preflight_explicit_exit");
assert.equal(explicitExit.exit_code, 42, "explicit PowerShell exit codes must pass through");

const cmdNativeDirectory = mkdtempSync(join(tmpdir(), "mcp-cmd-native-"));
try {
  const cmdInput = join(cmdNativeDirectory, "input.txt");
  writeFileSync(cmdInput, "CMD_NATIVE_REDIRECT_OK\r\n", "utf8");
  const nativeCmd = await run(`cmd.exe /d /c more < "${cmdInput}"`, "caller_cmd_native_redirect");
  assert.equal(nativeCmd.exit_code, 0, JSON.stringify(nativeCmd));
  assert.match(nativeCmd.stdout, /CMD_NATIVE_REDIRECT_OK/);
} finally {
  rmSync(cmdNativeDirectory, { recursive: true, force: true });
}

const busyActorDirectory = mkdtempSync(join(tmpdir(), "mcp-busy-actor-"));
try {
  writeFileSync(join(busyActorDirectory, "busy-python.cmd"), `@echo off\r\nset actor=%~2\r\nif /i "%actor:~0,8%"=="ChatGPT:" goto ok\r\nif /i "%actor:~0,8%"=="ChatGPT-" goto ok\r\nif /i "%actor:~0,8%"=="ChatGPT/" goto ok\r\necho claim actor must be ^<harness^>^<separator^>^<task/session suffix^>\r\nexit /b 2\r\n:ok\r\necho ACTOR=%actor%\r\n`, "utf8");
  const busyActorSubmitted = `& '.\\busy-python.cmd' claim 'chatgpt-test-normalized' scope`;
  const busyActor = await manager.startWithWait(busyActorSubmitted, busyActorDirectory, "caller_busy_actor_normalized", commandWaitMs);
  assert.equal(busyActor.exit_code, 0, JSON.stringify(busyActor));
  assert.match(busyActor.stdout, /ACTOR=ChatGPT-test-normalized/);
  assert.match(busyActor.command, /claim 'ChatGPT-test-normalized'/);
  assert.equal(busyActor.submitted_command, busyActorSubmitted);
  const arbitrarySubmitted = `& '.\\busy-python.cmd' claim 'rowan-test-repaired' scope`;
  const arbitraryActor = await manager.startWithWait(arbitrarySubmitted, busyActorDirectory, "caller_busy_actor_arbitrary", commandWaitMs);
  assert.equal(arbitraryActor.exit_code, 0, JSON.stringify(arbitraryActor));
  assert.match(arbitraryActor.stdout, /ACTOR=ChatGPT:rowan-test-repaired/);
  assert.equal(arbitraryActor.submitted_command, arbitrarySubmitted);
  assert.equal(arbitraryActor.repair_attempts, undefined, JSON.stringify(arbitraryActor));
  assert.match(arbitraryActor.command, /claim 'ChatGPT:rowan-test-repaired'/);
} finally {
  rmSync(busyActorDirectory, { recursive: true, force: true });
}

const atlasRepairDirectory = mkdtempSync(join(tmpdir(), "mcp-stack-atlas-repair-"));
try {
  const atlasScript = join(atlasRepairDirectory, "stack_atlas.py");
  writeFileSync(atlasScript, [
    "import sys",
    "if len(sys.argv) > 1 and sys.argv[1] == 'lookup':",
    "    print('usage: stack_atlas.py [-h]', file=sys.stderr)",
    "    print('stack_atlas.py: error: unknown Atlas lookup target: p3', file=sys.stderr)",
    "    raise SystemExit(2)",
    "print('ATLAS_FIND_OK ' + ' '.join(sys.argv[1:]))",
  ].join("\n"), "utf8");
  const atlasSubmitted = `python "${atlasScript}" lookup p3`;
  const atlasResult = await manager.startWithWait(atlasSubmitted, atlasRepairDirectory, "caller_stack_atlas_runtime_repair", commandWaitMs);
  assert.equal(atlasResult.exit_code, 0, JSON.stringify(atlasResult));
  assert.match(atlasResult.stdout, /ATLAS_FIND_OK find p3/);
  assert.equal(atlasResult.submitted_command, atlasSubmitted);
  assert.equal(atlasResult.repair_attempts?.length, 1, JSON.stringify(atlasResult));
  assert.equal(atlasResult.repair_attempts[0].reason, "stack_atlas_lookup_fallback_to_find");
  assert.match(atlasResult.repair_attempts[0].stderr, /unknown Atlas lookup target/);
} finally {
  rmSync(atlasRepairDirectory, { recursive: true, force: true });
}

const pytestModuleDirectory = mkdtempSync(join(tmpdir(), "mcp-pytest-module-"));
try {
  writeFileSync(join(pytestModuleDirectory, "pytest.py"), "import os\nprint('PYTEST_ROOT=' + os.environ.get('PYTEST_DEBUG_TEMPROOT',''))\n", "utf8");
  const escaped = pytestModuleDirectory.replaceAll("'", "''");
  const isolatedPytest = await run(`$env:PYTHONPATH='${escaped}'; python -m pytest`, "caller_pytest_isolated_temp_root");
  assert.equal(isolatedPytest.exit_code, 0, JSON.stringify(isolatedPytest));
  assert.match(isolatedPytest.stdout, /PYTEST_ROOT=.*mcp-pytest/i);
} finally {
  rmSync(pytestModuleDirectory, { recursive: true, force: true });
}

const runtime = await run("Write-Output $PSVersionTable.PSEdition; Write-Output $PSVersionTable.PSVersion.ToString(); Write-Output (Get-Process -Id $PID).Path", "caller_pwsh_runtime");
assert.match(runtime.stdout, /Core/);
assert.match(runtime.stdout, /7\.6\.5/);
assert.match(runtime.stdout, /C:\\Program Files\\PowerShell\\7\\pwsh\.exe/i);

const operators = await run("cmd.exe /c exit 0 && Write-Output AND_OK; cmd.exe /c exit 1 || Write-Output OR_OK; $value = $null ?? 'NULL_OK'; Write-Output $value", "caller_pwsh_operators");
assert.match(operators.stdout, /AND_OK/);
assert.match(operators.stdout, /OR_OK/);
assert.match(operators.stdout, /NULL_OK/);

const pidAssignmentSubmitted = "$PID = 123; Write-Output $PID";
const pidAssignment = await run(pidAssignmentSubmitted, "caller_pwsh_pid_assignment_normalized");
assert.equal(pidAssignment.exit_code, 0, JSON.stringify(pidAssignment));
assert.match(pidAssignment.stdout, /123/);
assert.match(pidAssignment.command, /\$mcpPid = 123/);
assert.equal(pidAssignment.submitted_command, pidAssignmentSubmitted);
const pidIncrement = await run("$PID++; Write-Output $PID", "caller_pwsh_pid_increment_normalized");
assert.equal(pidIncrement.exit_code, 0, JSON.stringify(pidIncrement));
assert.match(pidIncrement.command, /\$mcpPid\+\+/);
const hostParameterSubmitted = "function Probe([string]$host){ Write-Output $host }; Probe 'HOST_OK'";
const hostParameter = await run(hostParameterSubmitted, "caller_pwsh_host_parameter_normalized");
assert.equal(hostParameter.exit_code, 0, JSON.stringify(hostParameter));
assert.match(hostParameter.stdout, /HOST_OK/);
assert.match(hostParameter.command, /\$mcpHost/);
assert.equal(hostParameter.submitted_command, hostParameterSubmitted);
const writableArgs = await run("$args = @('good'); Write-Output ($args -join ',')", "caller_pwsh_args_assignment_allowed");
assert.equal(writableArgs.exit_code, 0, JSON.stringify(writableArgs));
assert.match(writableArgs.stdout, /good/);

const headResult = await run("git rev-parse HEAD", "caller_git_revspec_head");
assert.equal(headResult.exit_code, 0, JSON.stringify(headResult));
const headCommit = headResult.stdout.trim();
assert.match(headCommit, /^[0-9a-f]{40}$/);
const peelSubmitted = `git cat-file -e ${headCommit}^{commit}; if($LASTEXITCODE -eq 0){ Write-Output 'GIT_COMMIT_PEEL_OK' }`;
const peelResult = await run(peelSubmitted, "caller_git_revspec_peel_normalized");
assert.equal(peelResult.exit_code, 0, JSON.stringify(peelResult));
assert.match(peelResult.stdout, /GIT_COMMIT_PEEL_OK/);
assert.match(peelResult.command, /git cat-file -e '[0-9a-f]{40}\^\{commit\}'/);
assert.equal(peelResult.submitted_command, peelSubmitted);

const historicalNestedExpansion = String.raw`$childOnlyPath=''; powershell.exe -Command "Test-Path -LiteralPath \"$childOnlyPath\""`;
rejects(historicalNestedExpansion, /Invoke-LiteralScript\.ps1/);
const directNestedShell = await run(String.raw`pwsh.exe -NoProfile -Command "Write-Output $env:TEMP"`, "caller_nested_pwsh_direct");
assert.equal(directNestedShell.exit_code, 0, JSON.stringify(directNestedShell));
assert.equal(directNestedShell.execution_mode, "explicit_shell", JSON.stringify(directNestedShell));
assert.match(directNestedShell.stdout, /\\Temp/i);
const parentLiteralExpansion = await run(String.raw`$wt='C:\safe-parent'; pwsh.exe -NoProfile -Command "Write-Output '$wt\child'"`, "caller_nested_parent_literal_expansion_allowed");
assert.equal(parentLiteralExpansion.exit_code, 0, JSON.stringify(parentLiteralExpansion));
assert.match(parentLiteralExpansion.stdout, /C:\\safe-parent\\child/);
const repairedNestedQuotes = await run(String.raw`$wt='C:\\unsafe-parent'; pwsh.exe -NoProfile -Command "Write-Output '$wt\\child \\"quoted\\"'"`, "caller_nested_cstyle_quotes_repaired");
assert.equal(repairedNestedQuotes.exit_code, 0, JSON.stringify(repairedNestedQuotes));
assert.equal(repairedNestedQuotes.repair_attempts, undefined, JSON.stringify(repairedNestedQuotes));
assert.match(repairedNestedQuotes.stdout, /unsafe-parent/);

const nestedSingleQuoted = await run(String.raw`pwsh.exe -NoProfile -Command 'Write-Output $env:TEMP'`, "caller_nested_single_quoted_allowed");
assert.equal(nestedSingleQuoted.exit_code, 0, JSON.stringify(nestedSingleQuoted));
const nestedLiteralDoubleQuoted = await run(String.raw`pwsh.exe -NoProfile -Command "Write-Output NESTED_LITERAL_OK"`, "caller_nested_literal_double_allowed");
assert.equal(nestedLiteralDoubleQuoted.exit_code, 0, JSON.stringify(nestedLiteralDoubleQuoted));
assert.match(nestedLiteralDoubleQuoted.stdout, /NESTED_LITERAL_OK/);
const nestedEscapedVariable = await run("pwsh.exe -NoProfile -Command \"Write-Output `$env:TEMP\"", "caller_nested_escaped_variable_allowed");
assert.equal(nestedEscapedVariable.exit_code, 0, JSON.stringify(nestedEscapedVariable));
const encodedChild = Buffer.from("Write-Output 'NESTED_ENCODED_OK'", "utf16le").toString("base64");
const nestedEncoded = await run(`pwsh.exe -NoProfile -EncodedCommand ${encodedChild}`, "caller_nested_encoded_allowed");
assert.equal(nestedEncoded.exit_code, 0, JSON.stringify(nestedEncoded));
assert.match(nestedEncoded.stdout, /NESTED_ENCODED_OK/);
const nestedFile = await run(String.raw`pwsh.exe -NoProfile -File C:\definitely-missing-mcp-preflight.ps1`, "caller_nested_file_allowed");
assert.notEqual(nestedFile.exit_code, 0, "missing -File fixture should fail at execution, not preflight");
const nestedCommandLiteral = await run(String.raw`Write-Output 'pwsh.exe -Command "$env:TEMP"'; # powershell.exe -Command "$childOnlyPath"
Write-Output 'NESTED_COMMAND_LITERAL_ALLOWED'`, "caller_nested_command_literal_allowed");
assert.equal(nestedCommandLiteral.exit_code, 0, JSON.stringify(nestedCommandLiteral));
assert.match(nestedCommandLiteral.stdout, /NESTED_COMMAND_LITERAL_ALLOWED/);
const unrelatedLaterCommandOption = await run(String.raw`pwsh.exe -NoProfile -File C:\definitely-missing-mcp-preflight.ps1; Write-Output -Command "$env:TEMP"; Write-Output 'NESTED_SEGMENT_BOUNDARY_ALLOWED'`, "caller_nested_segment_boundary_allowed");
assert.match(unrelatedLaterCommandOption.stdout, /NESTED_SEGMENT_BOUNDARY_ALLOWED/);

const foreachPipelineSubmitted = "foreach ($x in 1,2) { $x } | Measure-Object | Select-Object -ExpandProperty Count";
const foreachPipeline = await run(foreachPipelineSubmitted, "caller_pwsh_foreach_pipeline_autonormalized");
assert.equal(foreachPipeline.exit_code, 0, JSON.stringify(foreachPipeline));
assert.match(foreachPipeline.stdout, /2/);
assert.match(foreachPipeline.command, /^@\(foreach /);
assert.equal(foreachPipeline.submitted_command, foreachPipelineSubmitted);

const forPipeline = await run("for ($i=0; $i -lt 2; $i++) { $i } | Measure-Object | Select-Object -ExpandProperty Count", "caller_pwsh_for_pipeline_autonormalized");
assert.match(forPipeline.stdout, /2/);
const whilePipeline = await run("$i=0; while ($i -lt 2) { $i; $i++ } | Measure-Object | Select-Object -ExpandProperty Count", "caller_pwsh_while_pipeline_autonormalized");
assert.match(whilePipeline.stdout, /2/);
const switchPipeline = await run("switch (1,2) { default { $_ } } | Measure-Object | Select-Object -ExpandProperty Count", "caller_pwsh_switch_pipeline_autonormalized");
assert.match(switchPipeline.stdout, /2/);
rejects("if ($true) { Write-Output 'x' } | Out-Null", /capture/);
rejects("if ($true) { Write-Output 'broken'", /unbalanced/);
rejects("Get-ChildItem C:\\ -Recurse", /drive[- ]root/);
rejects("gci -r 'D:\\'", /drive[- ]root/);
rejects("dir -Path C:/ -Recurse", /drive[- ]root/);
rejects("rg needle C:\\", /drive[- ]root/);
rejects("where.exe /R C:\\ *.txt", /drive[- ]root/);
rejects("findstr.exe /S needle C:\\*", /drive[- ]root/);
rejects("cmd.exe /c dir C:\\ /s", /drive[- ]root/);
rejects("tree.exe C:\\ /F", /drive[- ]root/);
rejects(`Get-ChildItem -LiteralPath '${psQuote(vaultRoot)}' -Recurse -File | Select-String needle`, /Vault root/);
rejects(`gci -r "${vaultRoot.replaceAll("\\", "/")}"`, /Vault root/);
rejects(`rg needle '${psQuote(vaultRoot)}'`, /Vault root/);
rejects(`where.exe /R "${vaultRoot}" *.txt`, /Vault root/);
rejects(`findstr.exe /S needle "${vaultRoot}\\*.txt"`, /Vault root/);
rejects(`cmd.exe /c dir "${vaultRoot}" /s`, /Vault root/);
rejects(`tree.exe "${vaultRoot}" /F`, /Vault root/);
rejects(`Get-ChildItem -LiteralPath '$env:USERPROFILE\\Desktop\\vault' -Recurse -File`, /Vault root/);
rejects(`rg needle '%USERPROFILE%\\Desktop\\vault'`, /Vault root/);
rejects("$pidToWait=20052; if(Get-Process -Id $pidToWait -ErrorAction SilentlyContinue){'WAIT_FOREIGN_UBT='+$pidToWait; Wait-Process -Id $pidToWait}; 'FOREIGN_UBT_EXITED'", /P3 build-slot waits/);
rejects("$lane='C:\\work'; $ownerPid=20052; while((Get-Date)-lt (Get-Date).AddMinutes(15)){if(-not (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)){break}; Start-Sleep -Milliseconds 200}; & (Join-Path $lane 'scripts\\Invoke-P3Build.ps1') -ProjectRoot $lane -Target Editor", /P3 build-slot polling/);
rejects("Wait-Process -Id 20052; & 'C:\\work\\scripts\\Invoke-P3HotSourceBuild.ps1' -Module P3Gameplay", /P3 build-slot waits/);
rejects("$lane='C:\\work'; $ubt='C:\\UE\\UnrealBuildTool.dll'; $slot=[Threading.Mutex]::new($false,'Global\\P3BuildGraphSlot_v3_1'); $held=$slot.WaitOne(120000); & $dot $ubt p3Editor Win64 Development '-Project=C:\\work\\p3.uproject' -Module=p3", /P3 build-slot mutex waits/);

rejects("python C:\\Users\\Lauri\\Desktop\\vault\\tools\\swarm_route.py route --work-id p3-2442-integration --kind portable-light; Write-Output 'LOCAL_WORK_CONTINUED'", /standalone start_process/);
rejects("python 'C:\\Users\\Lauri\\Desktop\\vault\\tools\\swarm_route.py' route --work-id p3-2442-integration --kind portable-light\nWrite-Output 'LOCAL_WORK_CONTINUED'", /standalone start_process/);
rejects("python C:\\Users\\Lauri\\Desktop\\vault\\tools\\swarm_route.py route --work-id p3-2442-integration --kind portable-light | ConvertFrom-Json", /standalone start_process/);
const standaloneRoute = await run("python 'C:\\definitely-missing\\swarm_route.py' route --work-id preflight-selftest --kind windows-only", "caller_swarm_route_standalone");
assert.notEqual(standaloneRoute.exit_code, 0, "missing fixture route should fail at execution, not preflight");
const routeLiterals = await run("Write-Output 'python C:\\fake\\swarm_route.py route --work-id literal --kind portable; Write-Output bad'; # python C:\\fake\\swarm_route.py route --work-id comment --kind portable\nWrite-Output 'ROUTE_LITERAL_ALLOWED'", "caller_swarm_route_literals");
assert.equal(routeLiterals.exit_code, 0, JSON.stringify(routeLiterals));
assert.match(routeLiterals.stdout, /ROUTE_LITERAL_ALLOWED/);

const pythonRouteLiteral = await run("python -c \"print('swarm_route.py route')\"; Write-Output 'PYTHON_ROUTE_LITERAL_ALLOWED'", "caller_python_swarm_route_literal");
assert.equal(pythonRouteLiteral.exit_code, 0, JSON.stringify(pythonRouteLiteral));
assert.match(pythonRouteLiteral.stdout, /PYTHON_ROUTE_LITERAL_ALLOWED/);

const ordinaryWait = await run("Wait-Process -Id 2147483647 -ErrorAction SilentlyContinue; Write-Output 'ORDINARY_WAIT_ALLOWED'", "caller_ordinary_wait_allowed");
assert.match(ordinaryWait.stdout, /ORDINARY_WAIT_ALLOWED/);
const ordinaryMutex = await run("$m=[Threading.Mutex]::new($false,'Local\\McpOrdinaryMutex'); try { [void]$m.WaitOne(1); Write-Output 'ORDINARY_MUTEX_ALLOWED' } finally { try { $m.ReleaseMutex() } catch {}; $m.Dispose() }", "caller_ordinary_mutex_allowed");
assert.match(ordinaryMutex.stdout, /ORDINARY_MUTEX_ALLOWED/);

const exactVaultRead = await run(`Get-Item -LiteralPath '${psQuote(vaultRoot)}' | Select-Object -ExpandProperty Name`, "caller_exact_vault_read");
assert.equal(exactVaultRead.exit_code, 0, JSON.stringify(exactVaultRead));
assert.match(exactVaultRead.stdout, /vault/i);
const boundedVaultSubdir = await run(`Get-ChildItem -LiteralPath '${psQuote(join(vaultRoot, "04 Operating Contracts", "__mcp_preflight_missing__"))}' -Recurse -ErrorAction SilentlyContinue; Write-Output 'VAULT_SUBDIR_ALLOWED'`, "caller_bounded_vault_subdir");
assert.equal(boundedVaultSubdir.exit_code, 0, JSON.stringify(boundedVaultSubdir));
assert.match(boundedVaultSubdir.stdout, /VAULT_SUBDIR_ALLOWED/);
const indexedVaultHelper = await run(`& python.exe '${psQuote(join(vaultRoot, "tools", "memory_bank.py"))}' --help`, "caller_vault_indexed_helper");
assert.equal(indexedVaultHelper.exit_code, 0, JSON.stringify(indexedVaultHelper));

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
  const durableRejectedCommand = "if ($true) { Write-Output 'broken'";
  assert.throws(
    () => durableManager.start(durableRejectedCommand, "C:\\Users\\Example", "caller_durable_preflight_reject"),
    /start_process_preflight_failed:/,
  );
  const day = new Date().toISOString().slice(0, 10);
  const dayDirectory = join(rejectionReceiptDirectory, "archive", day);
  const deadline = Date.now() + 2_000;
  let files = [];
  while (Date.now() < deadline) {
    try {
      files = readdirSync(dayDirectory).filter((name) => name.startsWith("rejected-") && name.endsWith(".json"));
      if (files.length > 0) break;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.equal(files.length, 1, `durable preflight rejection did not arrive within 2s: ${JSON.stringify(files)}`);
  const rejection = JSON.parse(readFileSync(join(dayDirectory, files[0]), "utf8"));
  assert.equal(rejection.kind, "process_preflight_rejection");
  assert.equal(rejection.caller_id, "caller_durable_preflight_reject");
  assert.equal(rejection.command, durableRejectedCommand);
  assert.match(rejection.reason, /unbalanced/);
  assert.ok(rejection.rejection_id);
} finally {
  rmSync(rejectionReceiptDirectory, { recursive: true, force: true });
}

console.log("PASS powershell_preflight pwsh=7.6.5 ps7_operators=true loop_pipeline_autonormalization=true nested_command_parent_expansion=guarded args_assignment=allowed drive_root_recursion=blocked vault_root_recursion=blocked bounded_recursion=allowed durable_rejections=true");
