import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager({ maxLivePerCaller: 8 });
const python = process.env.PYTHON || "python";
const code = "import os,sys,time; value=sys.stdin.read(); print(value, flush=True); print(os.getenv('DEDUPE_TOKEN',''), flush=True); time.sleep(2)";
const caller = "caller_structured_dedupe_test";
const started = [];

try {
  const first = manager.startStructured(python, ["-c", code], undefined, caller, undefined, "dedupe-test", "FIRST", { DEDUPE_TOKEN: "A" });
  started.push(first.process_id);
  const exactDuplicate = manager.startStructured(python, ["-c", code], undefined, caller, undefined, "dedupe-test", "FIRST", { DEDUPE_TOKEN: "A" });
  assert.equal(exactDuplicate.process_id, first.process_id, "semantically identical structured requests should still reuse the live process");

  const differentStdin = manager.startStructured(python, ["-c", code], undefined, caller, undefined, "dedupe-test", "SECOND", { DEDUPE_TOKEN: "A" });
  started.push(differentStdin.process_id);
  assert.notEqual(differentStdin.process_id, first.process_id, "different stdin must not reuse a live structured process");

  const differentEnv = manager.startStructured(python, ["-c", code], undefined, caller, undefined, "dedupe-test", "FIRST", { DEDUPE_TOKEN: "B" });
  started.push(differentEnv.process_id);
  assert.notEqual(differentEnv.process_id, first.process_id, "different environment must not reuse a live structured process");
  assert.notEqual(differentEnv.process_id, differentStdin.process_id, "stdin/env-distinct requests must remain distinct");

  const reorderedEnvA = manager.startStructured(python, ["-c", code], undefined, caller, undefined, "dedupe-env-order", "ORDER", { BETA: "2", ALPHA: "1" });
  started.push(reorderedEnvA.process_id);
  const reorderedEnvB = manager.startStructured(python, ["-c", code], undefined, caller, undefined, "dedupe-env-order", "ORDER", { ALPHA: "1", BETA: "2" });
  assert.equal(reorderedEnvB.process_id, reorderedEnvA.process_id, "environment key order must not change structured request identity");

  console.log("PASS structured_process_dedupe stdin_distinct=true env_distinct=true identical_reused=true env_order_stable=true");
} finally {
  for (const processId of new Set(started)) await manager.kill(processId).catch(() => undefined);
}
