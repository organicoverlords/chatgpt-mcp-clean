import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "../dist/lib/process-manager.js";

const receipts = await mkdtemp(join(tmpdir(), "mcp-default-host-cap-"));
const first = new ProcessManager({ maxLivePerCaller: 20, receiptDirectory: receipts });
const second = new ProcessManager({ maxLivePerCaller: 20, receiptDirectory: receipts });
const owned = [];
try {
  for (let i = 0; i < 12; i += 1) {
    const manager = i % 2 === 0 ? first : second;
    const started = manager.startStructured(process.execPath, ["-e", "setInterval(()=>{},1000)", String(i)], undefined, "host-cap-" + i);
    owned.push([manager, started.process_id]);
  }
  assert.throws(
    () => first.startStructured(process.execPath, ["-e", "setInterval(()=>{},1000)", "overflow"], undefined, "host-cap-overflow"),
    /start_process_host_concurrency_limited/,
  );
  console.log(JSON.stringify({ ok: true, default_host_cap: 12, managers: 2 }));
} finally {
  await Promise.all(owned.map(([manager, id]) => manager.kill(id).catch(() => undefined)));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(receipts, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exit(0);
