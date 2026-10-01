import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager();
const ids = [];
try {
  for (let index = 0; index < 6; index += 1) {
    const started = manager.startStructured(process.execPath, ["-e", `setInterval(() => {}, 1000); // ${index}`], undefined, "same-caller");
    ids.push(started.process_id);
    assert.equal(started.running, true);
  }
  assert.equal(new Set(ids).size, 6);
  for (const id of ids) assert.equal(manager.read(id).running, true);
  assert.throws(
    () => manager.startStructured(process.execPath, ["-e", "setInterval(() => {}, 1000); // seventh"], undefined, "same-caller"),
    /start_process_concurrency_limited: live_process_count=6; max_live_processes=6/,
  );
  const peer = manager.startStructured(process.execPath, ["-e", "setInterval(() => {}, 1000); // peer"], undefined, "other-caller");
  ids.push(peer.process_id);
  assert.equal(manager.read(peer.process_id).running, true);
  console.log("PASS six same-caller processes return distinct IDs, stay readable, seventh is rejected, other caller remains available");
} finally {
  await Promise.all(ids.map((id) => manager.kill(id).catch(() => undefined)));
}
