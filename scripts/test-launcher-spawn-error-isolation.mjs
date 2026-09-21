import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager({ maxLivePerCaller: 5 });
const missing = `mcp-definitely-missing-${process.pid}-${Date.now()}`;

const pipelinePlan = {
  mode: "native_pipeline",
  executable: missing,
  args: [],
  reason: "test_missing_executable_pipeline",
  steps: [
    { executable: missing, args: [], runIf: "always", reason: "test_missing_executable" },
    { executable: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], runIf: "always", reason: "test_pipeline_sink" },
  ],
};
const pipelineStarted = manager.startPrepared(
  "[test native pipeline missing executable]",
  pipelinePlan,
  undefined,
  "launcher-error-pipeline",
  undefined,
  undefined,
  undefined,
  [],
  "node",
  "policy",
  undefined,
  `pipeline-${missing}`,
  false,
);
const pipelineFailed = await manager.readWithWait(pipelineStarted.process_id, 100000, 5000);
assert.equal(pipelineFailed.running, false, "missing pipeline executable must terminate its request");
assert.equal(pipelineFailed.exit_code, -1);
assert.match(String(pipelineFailed.error ?? ""), /ENOENT|not receive a PID/i);

const afterPipeline = await manager.startStructuredWithWait(
  process.execPath,
  ["-e", "process.stdout.write('PIPELINE_RECOVERY_OK')"],
  undefined,
  "launcher-error-pipeline-recovery",
  5000,
);
assert.equal(afterPipeline.exit_code, 0, `launcher poisoned after pipeline ENOENT: ${JSON.stringify(afterPipeline)}`);
assert.match(String(afterPipeline.stdout ?? ""), /PIPELINE_RECOVERY_OK/);

const singleFailed = await manager.startStructuredWithWait(
  missing,
  [],
  undefined,
  "launcher-error-single",
  5000,
);
assert.equal(singleFailed.running, false, "missing single executable must terminate its request");
assert.equal(singleFailed.exit_code, -1);
assert.match(String(singleFailed.error ?? ""), /ENOENT|not receive a PID/i);

const afterSingle = await manager.startStructuredWithWait(
  process.execPath,
  ["-e", "process.stdout.write('SINGLE_RECOVERY_OK')"],
  undefined,
  "launcher-error-single-recovery",
  5000,
);
assert.equal(afterSingle.exit_code, 0, `launcher poisoned after single ENOENT: ${JSON.stringify(afterSingle)}`);
assert.match(String(afterSingle.stdout ?? ""), /SINGLE_RECOVERY_OK/);

console.log("PASS launcher_spawn_error_isolation pipeline_and_single_recover=true");
