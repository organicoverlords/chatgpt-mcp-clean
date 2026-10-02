import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager({ maxLivePerCaller: 2 });
const startedAt = performance.now();
const result = await manager.startStructuredWithWait(
  process.execPath,
  ["-e", "setTimeout(() => console.log('LATE_DONE'), 12000)"],
  process.cwd(),
  "start-wait-cap-test",
  60_000,
);
const elapsed = performance.now() - startedAt;
assert.equal(result.running, false, JSON.stringify(result));
assert.equal(result.next_action, "STOP_READING", JSON.stringify(result));
assert.match(result.stdout || "", /LATE_DONE/, JSON.stringify(result));
assert.ok(typeof result.process_id === "string" && result.process_id.length > 0);
assert.ok(elapsed >= 11_000 && elapsed < 16_000, `requested 60s start wait must remain active through process completion, got ${elapsed.toFixed(1)}ms`);
await manager.kill(result.process_id);
console.log(`PASS start_wait_contract requested_ms=60000 elapsed_ms=${elapsed.toFixed(1)} completed=true`);
process.exit(0);
