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
    () => manager.start(command, undefined, "caller_ps51_preflight_reject"),
    (error) => error instanceof Error && error.message.startsWith("start_process_preflight_failed:") && expected.test(error.message),
  );
}

const valid = await run("$values = @(foreach ($x in 1,2) { $x }); $values | Measure-Object | Select-Object -ExpandProperty Count", "caller_ps51_preflight_valid");
assert.equal(valid.exit_code, 0, JSON.stringify(valid));
assert.match(valid.stdout, /2/);

const nativeFailure = await run("cmd.exe /c exit 7", "caller_ps51_preflight_native_failure");
assert.equal(nativeFailure.exit_code, 1, "guard must preserve powershell.exe -Command failure semantics");
const explicitExit = await run("exit 42", "caller_ps51_preflight_explicit_exit");
assert.equal(explicitExit.exit_code, 42, "explicit PowerShell exit codes must pass through");

rejects("Write-Output one && Write-Output two", /does not support/);
rejects("Write-Output one || Write-Output two", /does not support/);
rejects("$PID = 123", /automatic/);
rejects("$PID++", /automatic/);
rejects("$args = @('bad')", /automatic/);
rejects("foreach ($x in 1) { $x } | Out-Null", /capture/);
rejects("if ($true) { Write-Output 'broken'", /unbalanced/);

// Guard text inside strings/comments/here-strings must not become false positives.
const literals = await run("$text='&& $PID = 1'; # || $args = 2\n$here=@'\nforeach ($x in 1) { $x } | Out-Null\n'@\nWrite-Output $text; Write-Output $here", "caller_ps51_preflight_literals");
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

console.log("PASS powershell_preflight known_ps51_hazards=blocked direct_command_semantics=preserved literals_ignored=true durable_rejections=true");
