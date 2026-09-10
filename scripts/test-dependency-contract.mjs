import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "mcp-dependency-contract-"));
const script = resolve(dirname(fileURLToPath(import.meta.url)), "verify-dependency-contract.mjs");
const SDK = "@modelcontextprotocol/sdk";

function fixture(name, { expected = "1.30.0", lockRoot = expected, lockResolved = expected, installed = expected } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { [SDK]: expected } }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { [SDK]: lockRoot } },
      [`node_modules/${SDK}`]: { version: lockResolved },
    },
  }));
  if (installed !== null) {
    const sdkDir = join(dir, "node_modules", "@modelcontextprotocol", "sdk");
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: SDK, version: installed }));
  }
  return dir;
}

function run(dir) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, MCP_DEPENDENCY_CONTRACT_ROOT: dir },
  });
}

try {
  const matching = run(fixture("matching"));
  assert.equal(matching.status, 0, matching.stderr);
  assert.match(matching.stdout, /PASS dependency_contract .*version=1\.30\.0/);

  const stale = run(fixture("stale", { installed: "1.24.3" }));
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /DEPENDENCY_CONTRACT_FAILED installed SDK drift expected=1\.30\.0 installed=1\.24\.3/);
  assert.match(stale.stderr, /verifier never mutates dependencies/);

  const missing = run(fixture("missing", { installed: null }));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /installed SDK drift expected=1\.30\.0 installed=missing/);

  const lockMismatch = run(fixture("lock-mismatch", { lockResolved: "1.24.3" }));
  assert.equal(lockMismatch.status, 1);
  assert.match(lockMismatch.stderr, /lock mismatch expected=1\.30\.0 root_lock=1\.30\.0 resolved_lock=1\.24\.3/);

  const nonExact = run(fixture("non-exact", { expected: "^1.30.0", lockRoot: "^1.30.0", lockResolved: "1.30.0", installed: "1.30.0" }));
  assert.equal(nonExact.status, 1);
  assert.match(nonExact.stderr, /root dependency @modelcontextprotocol\/sdk must be exact/);

  console.log("PASS dependency contract rejects stale, missing, lock-drifted, and non-exact MCP SDK installs without mutation");
} finally {
  rmSync(root, { recursive: true, force: true });
}
