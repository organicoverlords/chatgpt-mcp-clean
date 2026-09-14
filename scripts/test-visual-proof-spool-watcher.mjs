import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "mcp-proof-watch-"));
const spool = join(root, "ChatGPTMcpFrozen", "handoff-spool");
const queue = join(spool, "queue");
await mkdir(queue, { recursive: true });
const child = spawn(process.execPath, ["scripts/watch-visual-proof-spool.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, LOCALAPPDATA: root, MCP_VISUAL_SPOOL_POLL_MS: "25" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

const waitUntil = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
};
await waitUntil(() => stdout.includes("VISUAL_PROOF_WATCHER_READY"));

const expected = [];
for (let i = 0; i < 2; i++) {
  const bytes = Buffer.from(`proof-${i}-exact-bytes`);
  const file = join(spool, `proof-${i}.png`);
  await writeFile(file, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(queue, `${String(i).padStart(4, "0")}.json`), JSON.stringify({ path: file, bytes: bytes.length, sha256 }));
  expected.push(`CHATGPT_LIBRARY_UPLOAD=${file}`);
}
await waitUntil(() => expected.every((line) => stdout.includes(line)));
await waitUntil(async () => (await readdir(join(spool, "processed"))).length === 2);
child.kill("SIGTERM");
await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
for (const line of expected) assert.ok(stdout.includes(line));
assert.equal(stderr, "");
console.log("PASS visual_proof_spool_watcher one_process=true queued_images=2 markers=2 per_image_start=false");
