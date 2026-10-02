import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager();
const payloadChars = "iVBORw0KGgo".length + "AbCd0123+/".length * 60_000;
const first = await manager.startStructuredWithWait(
  process.execPath,
  ["-e", "process.stdout.write('iVBORw0KGgo' + 'AbCd0123+/'.repeat(60000))"],
  undefined,
  "base64-suppression-test",
  10_000,
);
assert.equal(first.running, false, "process exits");
assert.equal(first.next_action, "STOP_READING", "opaque payload does not force paging");
assert.ok(first.stdout.length < 1_000, "transport returns only compact suppression marker");
assert.match(first.stdout, /likely binary\/base64 text/i);
assert.equal(first.output_page.stdout_total, payloadChars);
assert.equal(first.output_page.stdout_end, payloadChars);
assert.equal(first.retained_stdout_chars, payloadChars, "audit retains exact output length");
assert.equal(first.evidence_completeness, "complete", "suppression does not discard retained evidence");
console.log("PASS base64_output_suppression retained=" + payloadChars + " transported=" + first.stdout.length);
