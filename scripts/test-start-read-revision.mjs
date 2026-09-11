import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager();
let started;
try {
  started = await manager.startWithWait(
    "Write-Output 'START_PACKET_VISIBLE'; Start-Sleep -Seconds 6",
    undefined,
    "caller_start_read_revision_test",
    2_500,
  );
  assert.equal(started.running, true, JSON.stringify(started));
  assert.match(started.stdout, /START_PACKET_VISIBLE/);

  const followupStartedAt = Date.now();
  const followup = await manager.readWithWait(started.process_id, 6_000, 250);
  const followupDurationMs = Date.now() - followupStartedAt;
  assert.equal(followup.running, true, JSON.stringify(followup));
  assert.equal(followup.no_change, true, JSON.stringify(followup));
  assert.equal(followup.stdout, "");
  assert.equal(followup.stderr, "");
  assert.ok(followupDurationMs >= 180, `first positive read replayed already-delivered start output (${followupDurationMs}ms)`);
  assert.ok(followupDurationMs < 1_000, `first positive read exceeded its wait bound (${followupDurationMs}ms)`);

  const snapshotReplay = await manager.readWithWait(started.process_id, 6_000, 0);
  assert.match(snapshotReplay.stdout, /START_PACKET_VISIBLE/, "nonblocking snapshots must still expose retained start output");
  console.log(`PASS start_read_revision wait_ms=${followupDurationMs}`);
} finally {
  if (started) await manager.kill(started.process_id).catch(() => undefined);
}