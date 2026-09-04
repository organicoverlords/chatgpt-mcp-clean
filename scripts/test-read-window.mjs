import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

function readAll(manager, first) {
  const pages = [first];
  while (pages.at(-1).next_action === "READ_SAME_PROCESS_ID") {
    pages.push(manager.read(first.process_id));
    assert.ok(pages.length < 100, "paging terminates");
  }
  return {
    pages,
    stdout: pages.map((page) => page.stdout).join(""),
    stderr: pages.map((page) => page.stderr).join(""),
  };
}

const manager = new ProcessManager({ maxLaunchesPerWindow: 8 });
const started = [];
try {
  const windowJob = await manager.startWithWait("Write-Output ('WINDOW_BEGIN_' + ('W' * 24000) + '_WINDOW_END')", undefined, "window-test", 10_000);
  started.push(windowJob.process_id);
  const windowOutput = readAll(manager, windowJob);
  assert.equal(windowOutput.pages.at(-1).stdout_truncated, undefined);
  assert.match(windowOutput.stdout, /^WINDOW_BEGIN_/);
  assert.match(windowOutput.stdout, /_WINDOW_END\r?\n?$/);
  assert.ok(windowOutput.stdout.length > 24_000);

  const floodJob = await manager.startWithWait("$payload = 'X' * 200; 1..500 | ForEach-Object { Write-Output (('FLOOD_{0}_{1}' -f $_,$payload)) }", undefined, "window-test", 10_000);
  started.push(floodJob.process_id);
  const floodOutput = readAll(manager, floodJob);
  assert.equal(floodOutput.pages.at(-1).stdout_truncated, true);
  assert.ok(floodOutput.stdout.length <= 100_000);
  assert.ok(floodOutput.stdout.length > 32_000);
  assert.match(floodOutput.stdout, /FLOOD_500_/);
  console.log(`PASS read_window whole=${windowOutput.stdout.length} retained=${floodOutput.stdout.length} pages=${floodOutput.pages.length}`);
} finally {
  for (const processId of started) await manager.kill(processId).catch(() => undefined);
}
