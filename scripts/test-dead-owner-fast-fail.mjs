import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "../dist/lib/process-manager.js";

const root = mkdtempSync(join(tmpdir(), "mcp-dead-owner-fast-"));
let failed = false;
let ownerProcessId;
try {
  const owner = new ProcessManager({ receiptDirectory: root });
  const requester = new ProcessManager({ receiptDirectory: root });

  const started = await owner.startStructuredWithWait(
    process.execPath,
    ["-e", "console.log('OWNER_READY'); setTimeout(() => {}, 5000)"],
    undefined,
    "owner-caller",
    0,
  );
  ownerProcessId = started.process_id;
  const liveAt = Date.now();
  const live = await requester.readOutput(ownerProcessId, 2000, 1000);
  const liveElapsed = Date.now() - liveAt;
  assert.equal(live.running, true, JSON.stringify(live));
  assert.match(live.stdout, /OWNER_READY/);
  assert.ok(liveElapsed < 2500, "live owner handoff too slow: " + liveElapsed + "ms");

  const unknownProcessId = randomUUID();
  const deadAt = Date.now();
  await assert.rejects(
    () => requester.readOutput(unknownProcessId, 2000, 10000),
    /Process owner unavailable/,
  );
  const deadElapsed = Date.now() - deadAt;
  assert.ok(deadElapsed < 2000, "dead owner inherited requested wait_ms: " + deadElapsed + "ms");

  await owner.kill(ownerProcessId);
  ownerProcessId = undefined;
  console.log("PASS owner_claim_handoff live_ms=" + liveElapsed + " dead_ms=" + deadElapsed);
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
process.exit(failed ? 1 : 0);
