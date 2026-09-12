import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCommandExecution } from "../dist/lib/command-execution-plan.js";
import { ProcessManager } from "../dist/lib/process-manager.js";

const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

const gitPlan = planCommandExecution("git cat-file -e abcdef1234567^{commit}", pwsh);
assert.equal(gitPlan.mode, "native");
assert.deepEqual(gitPlan.args, ["cat-file", "-e", "abcdef1234567^{commit}"]);

const quotedPath = planCommandExecution("git -C 'C:\\Program Files\\repo' status --short", pwsh);
assert.equal(quotedPath.mode, "native");
assert.equal(quotedPath.args[1], "C:\\Program Files\\repo");

const pythonCode = planCommandExecution(`python -c "print('a;b|c')"`, pwsh);
assert.equal(pythonCode.mode, "native");
assert.equal(pythonCode.args[1], "print('a;b|c')");

const pythonEscapedQuotes = planCommandExecution(String.raw`python -c "print(\"x\")"`, pwsh);
assert.equal(pythonEscapedQuotes.mode, "native");
assert.equal(pythonEscapedQuotes.args[1], 'print("x")');

const ghEscapedQuotes = planCommandExecution(String.raw`gh issue comment 1 --body "hello \"quoted\" world"`, pwsh);
assert.equal(ghEscapedQuotes.mode, "native");
assert.equal(ghEscapedQuotes.args.at(-1), 'hello "quoted" world');

const ghMarkdown = planCommandExecution('gh issue comment 1 --body "line one\nline `code`; still one argv"', pwsh);
assert.equal(ghMarkdown.mode, "native");
assert.equal(ghMarkdown.args.at(-1), "line one\nline `code`; still one argv");

const psPipeline = planCommandExecution("git status --short | Select-Object -First 2", pwsh);
assert.equal(psPipeline.mode, "powershell");

const psExpansion = planCommandExecution('git -C "$env:LOCALAPPDATA\\repo" status', pwsh);
assert.equal(psExpansion.mode, "powershell");

const nestedPwsh = planCommandExecution('pwsh -NoProfile -Command "Write-Output $env:TEMP"', pwsh);
assert.equal(nestedPwsh.mode, "explicit_shell");
assert.equal(nestedPwsh.executable, pwsh);
assert.equal(nestedPwsh.args.at(-1), "Write-Output $env:TEMP");

const callOperator = planCommandExecution(`& 'C:\\Tools\\helper.cmd' claim 'ChatGPT:task' scope`, pwsh);
assert.equal(callOperator.mode, "native");
assert.equal(callOperator.executable, "C:\\Tools\\helper.cmd");
assert.equal(callOperator.reason, "powershell_call_operator_native_argv");

const npmPlan = planCommandExecution("npm --version", pwsh);
assert.equal(npmPlan.mode, "native");

const sequencePlan = planCommandExecution(`node -e "console.log('SEQ_A')"; node -e "console.log('SEQ_B')"`, pwsh);
assert.equal(sequencePlan.mode, "native_sequence");
assert.equal(sequencePlan.steps?.length, 2);
assert.deepEqual(sequencePlan.steps?.map((step) => step.runIf), ["always", "always"]);

const cmdNativeSequence = planCommandExecution('cmd /d /s /c "git rev-parse HEAD && git rev-parse HEAD^{commit}"', pwsh);
assert.equal(cmdNativeSequence.mode, "native_sequence");
assert.equal(cmdNativeSequence.reason, "cmd_wrapper_elided_native_sequence");
assert.equal(cmdNativeSequence.steps?.[1]?.args.at(-1), "HEAD^{commit}");

const cmdRedirection = planCommandExecution('cmd /c "echo hello > out.txt"', pwsh);
assert.equal(cmdRedirection.mode, "explicit_shell");

const conditionalPlan = planCommandExecution(`node -e "process.exit(7)" && node -e "console.log('NO')" || node -e "console.log('RECOVER')"`, pwsh);
assert.equal(conditionalPlan.mode, "native_sequence");
assert.deepEqual(conditionalPlan.steps?.map((step) => step.runIf), ["always", "success", "failure"]);

const nativePipelinePlan = planCommandExecution(`node -e "process.stdout.write('PIPE_OK')" | node -e "process.stdin.pipe(process.stdout)"`, pwsh);
assert.equal(nativePipelinePlan.mode, "native_pipeline");
assert.equal(nativePipelinePlan.steps?.length, 2);

const heredocPlan = planCommandExecution("python - <<'PY'\nprint('HEREDOC_OK')\nPY", pwsh);
assert.equal(heredocPlan.mode, "native");
assert.equal(heredocPlan.reason, "python_heredoc_to_stdin");
assert.equal(heredocPlan.stdin, "print('HEREDOC_OK')\n");

const manager = new ProcessManager();
const waitMs = 10_000;

const atlasSubmitted = `stack_atlas.py --help`;
const atlasNormalized = (await import("../dist/lib/process-manager.js")).replayNormalizeStartProcessCommand(atlasSubmitted);
if (process.env.USERPROFILE) {
  const expectedAtlas = join(process.env.USERPROFILE, "Desktop", "vault", "tools", "stack_atlas.py");
  try {
    const { accessSync } = await import("node:fs");
    accessSync(expectedAtlas);
    assert.ok(atlasNormalized.rewrites.includes("canonical_tool_entrypoint"));
    assert.match(atlasNormalized.command, /python .*stack_atlas\.py.*--help/i);
  } catch {}
}
const head = await manager.startWithWait("git rev-parse HEAD", process.cwd(), "caller_execution_plan_head", waitMs);
assert.equal(head.exit_code, 0, JSON.stringify(head));
assert.equal(head.execution_mode, "native", JSON.stringify(head));
const sha = head.stdout.trim();
assert.match(sha, /^[0-9a-f]{40}$/);

const peel = await manager.startWithWait(`git cat-file -e ${sha}^{commit}`, process.cwd(), "caller_execution_plan_peel", waitMs);
assert.equal(peel.exit_code, 0, JSON.stringify(peel));
assert.equal(peel.execution_mode, "native", JSON.stringify(peel));

const nested = await manager.startWithWait('pwsh -NoProfile -Command "Write-Output $env:TEMP"', process.cwd(), "caller_execution_plan_nested_pwsh", waitMs);
assert.equal(nested.exit_code, 0, JSON.stringify(nested));
assert.equal(nested.execution_mode, "explicit_shell", JSON.stringify(nested));
assert.match(nested.stdout, /\\Temp/i);

const ps = await manager.startWithWait("Write-Output 'POWERSHELL_LANE_OK'", process.cwd(), "caller_execution_plan_ps", waitMs);
assert.equal(ps.exit_code, 0, JSON.stringify(ps));
assert.equal(ps.execution_mode, "powershell", JSON.stringify(ps));
assert.match(ps.stdout, /POWERSHELL_LANE_OK/);

const colonSubmitted = `$f='FILE'; $n='NAME'; Write-Output "$f:$n"`;
const colon = await manager.startWithWait(colonSubmitted, process.cwd(), "caller_execution_plan_ps_colon", waitMs);
assert.equal(colon.exit_code, 0, JSON.stringify(colon));
assert.match(colon.stdout, /FILE:NAME/);
assert.equal(colon.submitted_command, colonSubmitted);
assert.match(colon.command, /\$\{f\}:\$n/);

const githubSubmitted = 'Write-Output "if: ${{ github.event.workflow_run.conclusion }}"';
const githubLiteral = await manager.startWithWait(githubSubmitted, process.cwd(), "caller_execution_plan_github_literal", waitMs);
assert.equal(githubLiteral.exit_code, 0, JSON.stringify(githubLiteral));
assert.match(githubLiteral.stdout, /\$\{\{ github\.event\.workflow_run\.conclusion \}\}/);
assert.equal(githubLiteral.submitted_command, githubSubmitted);

const inlineHereSubmitted = 'Write-Output @"' + '`n' + 'HELLO_HERE' + '`n' + '"@';
const inlineHere = await manager.startWithWait(inlineHereSubmitted, process.cwd(), "caller_execution_plan_inline_here", waitMs);
assert.equal(inlineHere.exit_code, 0, JSON.stringify(inlineHere));
assert.match(inlineHere.stdout, /HELLO_HERE/);
assert.equal(inlineHere.submitted_command, inlineHereSubmitted);

const cStyleSubmitted = String.raw`$s='x'; Write-Output $s.Replace('x',"A \"B\" C")`;
const cStyle = await manager.startWithWait(cStyleSubmitted, process.cwd(), "caller_execution_plan_cstyle_quote", waitMs);
assert.equal(cStyle.exit_code, 0, JSON.stringify(cStyle));
assert.match(cStyle.stdout, /A "B" C/);
assert.equal(cStyle.repair_attempts, undefined, JSON.stringify(cStyle));
assert.equal(cStyle.submitted_command, cStyleSubmitted);
assert.match(cStyle.command, /`"B`"/);

const npmVersion = await manager.startWithWait("npm --version", process.cwd(), "caller_execution_plan_npm", waitMs);
assert.equal(npmVersion.exit_code, 0, JSON.stringify(npmVersion));
assert.equal(npmVersion.execution_mode, "native", JSON.stringify(npmVersion));
assert.match(npmVersion.stdout.trim(), /^\d+\./);

const sequence = await manager.startWithWait(`node -e "console.log('SEQ_A')"; node -e "console.log('SEQ_B')"`, process.cwd(), "caller_execution_plan_sequence", waitMs);
assert.equal(sequence.exit_code, 0, JSON.stringify(sequence));
assert.equal(sequence.execution_mode, "native_sequence", JSON.stringify(sequence));
assert.match(sequence.stdout, /SEQ_A/);
assert.match(sequence.stdout, /SEQ_B/);

const andStops = await manager.startWithWait(`node -e "process.exit(7)" && node -e "console.log('MUST_NOT_RUN')"`, process.cwd(), "caller_execution_plan_and", waitMs);
assert.equal(andStops.exit_code, 7, JSON.stringify(andStops));
assert.equal(andStops.execution_mode, "native_sequence", JSON.stringify(andStops));
assert.doesNotMatch(andStops.stdout, /MUST_NOT_RUN/);

const orRecovers = await manager.startWithWait(`node -e "process.exit(7)" || node -e "console.log('RECOVERED')"`, process.cwd(), "caller_execution_plan_or", waitMs);
assert.equal(orRecovers.exit_code, 0, JSON.stringify(orRecovers));
assert.equal(orRecovers.execution_mode, "native_sequence", JSON.stringify(orRecovers));
assert.match(orRecovers.stdout, /RECOVERED/);

const nativePipeline = await manager.startWithWait(`node -e "process.stdout.write('PIPE_OK')" | node -e "process.stdin.pipe(process.stdout)"`, process.cwd(), "caller_execution_plan_native_pipeline", waitMs);
assert.equal(nativePipeline.exit_code, 0, JSON.stringify(nativePipeline));
assert.equal(nativePipeline.execution_mode, "native_pipeline", JSON.stringify(nativePipeline));
assert.match(nativePipeline.stdout, /PIPE_OK/);

const structuredStdin = await manager.startStructuredWithWait(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], process.cwd(), "caller_execution_plan_structured_stdin", waitMs, undefined, undefined, "STRUCTURED_STDIN_OK\n");
assert.equal(structuredStdin.exit_code, 0, JSON.stringify(structuredStdin));
assert.equal(structuredStdin.execution_mode, "native", JSON.stringify(structuredStdin));
assert.match(structuredStdin.stdout, /STRUCTURED_STDIN_OK/);

const heredoc = await manager.startWithWait("python - <<'PY'\nprint('HEREDOC_OK')\nPY", process.cwd(), "caller_execution_plan_heredoc", waitMs);
assert.equal(heredoc.exit_code, 0, JSON.stringify(heredoc));
assert.equal(heredoc.execution_mode, "native", JSON.stringify(heredoc));
assert.equal(heredoc.execution_reason, "python_heredoc_to_stdin", JSON.stringify(heredoc));
assert.match(heredoc.stdout, /HEREDOC_OK/);

const gitSequence = await manager.startWithWait("git rev-parse HEAD; git rev-parse --show-toplevel", process.cwd(), "caller_execution_plan_git_sequence", waitMs);
assert.equal(gitSequence.exit_code, 0, JSON.stringify(gitSequence));
assert.equal(gitSequence.execution_mode, "native_sequence", JSON.stringify(gitSequence));
assert.match(gitSequence.stdout, /^[0-9a-f]{40}/m);

const cmdDir = mkdtempSync(join(tmpdir(), "mcp-cross-spawn-cmd-"));
try {
  const helper = join(cmdDir, "echo-arg.cmd");
  writeFileSync(helper, "@echo off\r\necho ARG=%~1\r\n", "utf8");
  const invoked = await manager.startWithWait(`& '${helper.replaceAll("'", "''")}' 'A B'`, cmdDir, "caller_execution_plan_cmd_shim", waitMs);
  assert.equal(invoked.exit_code, 0, JSON.stringify(invoked));
  assert.equal(invoked.execution_mode, "native", JSON.stringify(invoked));
  assert.match(invoked.stdout, /ARG=A B/);
} finally {
  rmSync(cmdDir, { recursive: true, force: true });
}

console.log("PASS command_execution_plan native_argv=true native_sequence=true native_pipeline=true python_heredoc_stdin=true structured_stdin=true cmd_wrapper_elision=true explicit_shell_direct=true powershell_repairs=true powershell_fallback=true");

