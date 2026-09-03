import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "../dist/lib/process-manager.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForExit(manager, processId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = manager.read(processId);
    if (!state.running) return state;
    await sleep(10);
  }
  throw new Error(`process ${processId} did not exit during the archive test`);
}

const receiptDirectory = mkdtempSync(join(tmpdir(), "mcp-durable-receipt-"));
try {
  const manager = new ProcessManager({ receiptDirectory });
  const started = manager.start("Write-Output 'DURABLE_RECEIPT_OK'", undefined, "caller_receipt_archive_test");
  const completed = await waitForExit(manager, started.process_id);
  assert.equal(completed.exit_code, 0);

  const archiveDay = completed.finished_at.slice(0, 10);
  const archivedPath = join(receiptDirectory, "archive", archiveDay, `${started.process_id}.json`);
  assert.equal(existsSync(archivedPath), true, "new receipts must be archived immediately");

  // Simulate an upgrade from the legacy flat-only layout, then age the hot receipt past
  // its 30-minute handoff window. Constructor pruning must migrate before deleting.
  rmSync(join(receiptDirectory, "archive"), { recursive: true, force: true });
  const hotReceiptPath = join(receiptDirectory, `${started.process_id}.json`);
  const expiredHotReceiptTime = new Date(Date.now() - 31 * 60 * 1000);
  utimesSync(hotReceiptPath, expiredHotReceiptTime, expiredHotReceiptTime);

  const afterHotExpiry = new ProcessManager({ receiptDirectory });
  assert.equal(existsSync(hotReceiptPath), false, "expired hot receipt should leave the flat directory only after archival");
  assert.equal(existsSync(archivedPath), true, "legacy flat receipt must be migrated to the durable archive");
  const recovered = afterHotExpiry.read(started.process_id);
  assert.equal(recovered.exit_code, 0);
  assert.match(recovered.stdout, /DURABLE_RECEIPT_OK/, "receipt must remain readable after the 30-minute hot-cache window");

  const staleArchiveDirectory = join(receiptDirectory, "archive", "2000-01-01");
  mkdirSync(staleArchiveDirectory, { recursive: true });
  writeFileSync(join(staleArchiveDirectory, "stale.json"), "{}", "utf8");
  new ProcessManager({ receiptDirectory });
  assert.equal(existsSync(staleArchiveDirectory), false, "stale day shards must be pruned by durable retention");
} finally {
  rmSync(receiptDirectory, { recursive: true, force: true });
}

console.log("PASS durable process receipts survive the hot-cache window and stale day shards are pruned");
