import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager();
const script = `from pathlib import Path
Path("definitely-missing.txt").read_text(newline="")
`;
const result = await manager.startScriptWithWait("python", script, undefined, "caller_structured_repair_test", 2_000, undefined, "structured-repair-test");
assert.equal(result.running, false, JSON.stringify(result));
assert.equal(result.execution_reason, "structured_script_python_stdin", JSON.stringify(result));
assert.match(result.stderr, /Path\.read_text\(\) got an unexpected keyword argument ['"]newline['"]/, JSON.stringify(result));
assert.doesNotMatch(result.stderr, /SyntaxError:/, JSON.stringify(result));
assert.equal(result.repair_attempts, undefined, `structured execution must not retry through legacy command rendering: ${JSON.stringify(result)}`);
console.log("PASS structured_runtime_repair original_failure_preserved=true legacy_retry=false");
