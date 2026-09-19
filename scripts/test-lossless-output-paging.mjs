import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager();
const payloadChars = 90_000;
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
  pages.push(manager.read(first.process_id, 100_000));
  assert.ok(pages.length < 10, "paging terminates");
}

for (const page of pages) {
  if (!page.output_page) continue;
  assert.ok(page.output_page.page_chars <= 100_000, "logical page never exceeds 100k");
  assert.equal(page.output_page.page_limit, 100_000, "page uses current 100k read contract");
}
assert.ok(pages[0].stdout.length > 30_000, "first page is not constrained by the stale 6k assumption");
assert.equal(pages.map((page) => page.stdout).join(""), expectedStdout, "all retained stdout is returned losslessly in order");
assert.equal(pages.map((page) => page.stderr).join(""), expectedStderr, "all retained stderr is returned losslessly in order");
assert.equal(pages.at(-1).next_action, "STOP_READING");
assert.equal(pages.at(-1).output_page.more, false);
assert.ok(pages.length >= 2, "combined retained output must exercise multi-page delivery at the 100k cap");
console.log(`PASS lossless_output_100k pages=${pages.length} chars=${expectedStdout.length + expectedStderr.length} first_page=${pages[0].output_page.page_chars}`);
