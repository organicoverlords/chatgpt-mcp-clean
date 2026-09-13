import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const managerUrl = new URL(`file:///${resolve("dist/lib/process-manager.js").replaceAll("\\", "/")}`);
const code = `
  const { ProcessManager } = await import(${JSON.stringify(managerUrl.href)});
  const manager = new ProcessManager();
  const result = await manager.startWithWait("Write-Output EXECARGV_WORKER_OK", undefined, "execargv-regression", 10000);
  if (result.exit_code !== 0 || !String(result.stdout || "").includes("EXECARGV_WORKER_OK")) { console.error(JSON.stringify(result)); process.exit(9); }
  process.stdout.write("EXECARGV_WORKER_OK\\n");
  process.exit(0);
`;
const run = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { encoding: "utf8", timeout: 30_000 });
assert.equal(run.status, 0, `stdout=${run.stdout} stderr=${run.stderr}`);
assert.match(run.stdout, /EXECARGV_WORKER_OK/);
assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, /--input-type can only be used|process launcher unavailable/i);
console.log("PASS worker_execargv input_type_parent=true launcher_worker_healthy=true");
