import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "mcp-oauth-cross-process-"));
const store = join(root, "oauth.json");
const helper = fileURLToPath(new URL("./helpers/oauth-store-writer.mjs", import.meta.url));

function run(name, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, store, name, String(port)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || "writer exit " + code)));
  });
}

try {
  const [first, second] = await Promise.all([
    run("cross-process-a", 43101),
    run("cross-process-b", 43102),
  ]);
  assert.ok(first && second && first !== second);
  const state = JSON.parse(await readFile(store, "utf8"));
  const names = Object.values(state.clients).map((client) => client.client_name).sort();
  assert.deepEqual(names, ["cross-process-a", "cross-process-b"]);
  console.log(JSON.stringify({ ok: true, clients: names }));
} finally {
  await rm(root, { recursive: true, force: true });
}
