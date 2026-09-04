import assert from "node:assert/strict";
import { ProcessManager } from "../dist/lib/process-manager.js";

const manager = new ProcessManager();
const payloadChars = 90_000;
const expected = `BEGIN_${"A".repeat(payloadChars)}_END\r\n`;
const first = await manager.startWithWait(
  `Write-Output ('BEGIN_' + ('A' * ${payloadChars}) + '_END')`,
  undefined,
  "paging-test",
  10_000,
);
assert.equal(first.running, false, "process exits");

const pages = [first];
while (pages.at(-1).next_action === "READ_SAME_PROCESS_ID") {
  pages.push(manager.read(first.process_id, 32_000));
  assert.ok(pages.length < 10, "paging terminates");
}

for (const page of pages) {
  if (!page.output_page) continue;
  assert.ok(page.output_page.page_chars <= 32_000, "logical page never exceeds 32k");
  assert.equal(page.output_page.page_limit, 32_000, "page uses current 32k read contract");
}
assert.ok(pages[0].stdout.length > 30_000, "first page is not constrained by the stale 6k assumption");
assert.equal(pages.map((page) => page.stdout).join(""), expected, "all retained stdout is returned losslessly in order");
assert.equal(pages.at(-1).next_action, "STOP_READING");
assert.equal(pages.at(-1).output_page.more, false);
console.log(`PASS lossless_output_32k pages=${pages.length} chars=${expected.length} first_page=${pages[0].stdout.length}`);
