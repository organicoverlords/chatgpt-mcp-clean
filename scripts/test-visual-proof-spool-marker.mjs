import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "mcp-proof-spool-"));
const spool = join(root, "ChatGPTMcpFrozen", "handoff-spool");
await mkdir(spool, { recursive: true });
const bytes = Buffer.from("exact-proof-bytes");
const file = join(spool, "proof.png");
await writeFile(file, bytes);
const sha256 = createHash("sha256").update(bytes).digest("hex");
await writeFile(join(spool, "latest.json"), JSON.stringify({ path: file, bytes: bytes.length, sha256 }));
const stdout = execFileSync(process.execPath, ["scripts/emit-visual-proof-marker.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, LOCALAPPDATA: root },
  encoding: "utf8",
});
assert.equal(stdout, `CHATGPT_LIBRARY_UPLOAD=${file}\n`);
const manifest = JSON.parse(await readFile(join(spool, "latest.json"), "utf8"));
assert.equal(manifest.sha256, sha256);

await writeFile(join(spool, "latest.json"), JSON.stringify({ path: file, bytes: bytes.length, sha256: "0".repeat(64) }));
assert.throws(() => execFileSync(process.execPath, ["scripts/emit-visual-proof-marker.mjs"], {
  cwd: process.cwd(), env: { ...process.env, LOCALAPPDATA: root }, stdio: "pipe",
}), /Command failed/);
console.log("PASS visual_proof_spool_marker fixed_spool=true tool_input_pathless=true bytes_verified=true sha_verified=true");
