import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "../dist/lib/process-manager.js";

const directory = mkdtempSync(join(tmpdir(), "mcp-owned-pid-exit-"));
try {
  const helper = join(directory, "hold-inherited-stdio.cjs");
  writeFileSync(helper, `const { spawn } = require("node:child_process");\nconst child = spawn(process.execPath, ["-e", "setTimeout(()=>{},4000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });\nchild.unref();\nconsole.log("OWNER_PID_EXITING");\n`);

  const manager = new ProcessManager();
  const startedAt = Date.now();
  const queued = manager.startStructured(process.execPath, [helper], undefined, "caller_owned_pid_exit_test");
  let result = queued;
  let observedStdout = String(result.stdout ?? "");
  const deadline = startedAt + 2_000;
  while (Date.now() < deadline && result.running) {
    result = await manager.readWithWait(queued.process_id, 8_000, 100);
    observedStdout += String(result.stdout ?? "");
  }

  assert.equal(result.running, false, `owned PID remained live after exit: ${JSON.stringify(result)}`);
  assert.match(observedStdout, /OWNER_PID_EXITING/);
  assert.ok(Date.now() - startedAt < 2_000, `owned PID exit waited on descendant-inherited stdio for ${Date.now() - startedAt}ms`);
  const afterExit = await manager.kill(result.process_id);
  assert.equal(afterExit.already_exited, true, JSON.stringify(afterExit));
  console.log("owned-pid-exit: ok");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
