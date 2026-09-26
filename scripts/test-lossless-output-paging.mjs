import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager();
const payloadChars = 400_000;
const expectedStdout = `BEGIN_${"A".repeat(payloadChars)}_END`;
const expectedStderr = `ERR_${"B".repeat(payloadChars)}_END`;
const first = await manager.startWithWait(
  `[Console]::Out.Write('BEGIN_' + ('A' * ${payloadChars}) + '_END'); [Console]::Error.Write('ERR_' + ('B' * ${payloadChars}) + '_END')`,
  undefined,
  "paging-test",
  10_000,
);
assert.equal(first.running, false, "process exits");

const pages = [first];
while (pages.at(-1).next_action === "READ_SAME_PROCESS_ID") {
  pages.push(manager.read(first.process_id, 256_000));
  assert.ok(pages.length < 20, "paging terminates");
}

for (const page of pages) {
  if (!page.output_page) continue;
  assert.ok(page.output_page.page_chars <= 256_000, "logical page never exceeds 256k");
  assert.equal(page.output_page.page_limit, 256_000, "page uses current 256k read contract");
}
assert.equal(pages.map((page) => page.stdout).join(""), expectedStdout, "stdout is returned losslessly in order");
assert.equal(pages.map((page) => page.stderr).join(""), expectedStderr, "stderr is returned losslessly in order");
assert.equal(pages.at(-1).next_action, "STOP_READING");
assert.equal(pages.at(-1).output_page.more, false);
assert.ok(pages.length >= 4, "combined output must exercise multi-page delivery at the 256k cap");
assert.equal(first.evidence_completeness, "complete");
assert.equal(first.retained_stdout_chars, expectedStdout.length);
assert.equal(first.retained_stderr_chars, expectedStderr.length);
console.log(`PASS lossless_output_256k pages=${pages.length} chars=${expectedStdout.length + expectedStderr.length} first_page=${pages[0].output_page.page_chars}`);
