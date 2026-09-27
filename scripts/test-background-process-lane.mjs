import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager({ maxLivePerCaller: 1, maxBackgroundLivePerCaller: 2 });
const processes = [];
const longNode = (label) => ["-e", `console.log("${label}"); setTimeout(() => {}, 30000)`];

try {
  const backgroundOne = await manager.startStructuredWithWait(
    process.execPath,
    longNode("BACKGROUND_ONE"),
    process.cwd(),
    "caller_background_lane",
    0,
  );
  const backgroundTwo = await manager.startStructuredWithWait(
    process.execPath,
    longNode("BACKGROUND_TWO"),
    process.cwd(),
    "caller_background_lane",
    0,
  );
  processes.push(backgroundOne, backgroundTwo);
  assert.equal(backgroundOne.running, true);
  assert.equal(backgroundTwo.running, true);

  const interactive = manager.startStructured(
    process.execPath,
    longNode("INTERACTIVE_ONE"),
    process.cwd(),
    "caller_background_lane",
  );
  processes.push(interactive);
  assert.equal(interactive.running, true, "background launches must not consume the interactive caller slot");

  await assert.rejects(
    () => manager.startStructuredWithWait(
      process.execPath,
      longNode("BACKGROUND_THREE"),
      process.cwd(),
      "caller_background_lane",
      0,
    ),
    /start_process_background_concurrency_limited/,
  );

  assert.throws(
    () => manager.startStructured(
      process.execPath,
      longNode("INTERACTIVE_TWO"),
      process.cwd(),
      "caller_background_lane",
    ),
    /start_process_concurrency_limited/,
  );

  const backgroundRead = await manager.readOutput(backgroundOne.process_id, 8_000, 0);
  assert.equal(backgroundRead.process_id, backgroundOne.process_id);
  assert.equal(backgroundRead.running, true);

  console.log("PASS background_process_lane interactive_cap=1 background_cap=2 read_later=true");
} finally {
  for (const processResult of processes) {
    await manager.kill(processResult.process_id).catch(() => undefined);
  }
}
