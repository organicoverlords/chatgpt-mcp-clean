import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const temporary = mkdtempSync(join(tmpdir(), "mcp-deploy-owner-freshness-"));
const remote = join(temporary, "remote.git");
const seed = join(temporary, "seed");
const owner = join(temporary, "owner");
const guard = resolve("scripts/assert-deploy-owner-fresh.ps1");

function run(command, args, cwd = temporary) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}
function rev(cwd) {
  return run("git.exe", ["rev-parse", "HEAD"], cwd).stdout.trim();
}
function syncOwner(expectSuccess = true) {
  const result = spawnSync("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", guard, "-Root", owner,
  ], { cwd: resolve("."), encoding: "utf8" });
  if (expectSuccess) {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FRESH/);
  } else {
    assert.notEqual(result.status, 0, "unsafe deploy-owner state must fail closed");
  }
  return result;
}

try {
  run("git.exe", ["init", "--bare", remote]);
  mkdirSync(seed);
  run("git.exe", ["init", "-b", "main"], seed);
  run("git.exe", ["config", "user.name", "Freshness Test"], seed);
  run("git.exe", ["config", "user.email", "freshness@example.test"], seed);
  writeFileSync(join(seed, "state.txt"), "one\n", "utf8");
  run("git.exe", ["add", "state.txt"], seed);
  run("git.exe", ["commit", "-m", "initial"], seed);
  run("git.exe", ["remote", "add", "origin", remote], seed);
  run("git.exe", ["push", "-u", "origin", "main"], seed);
  run("git.exe", ["symbolic-ref", "HEAD", "refs/heads/main"], remote);
  run("git.exe", ["clone", "--branch", "main", remote, owner]);
  run("git.exe", ["config", "user.name", "Owner Test"], owner);
  run("git.exe", ["config", "user.email", "owner@example.test"], owner);

  const initial = rev(owner);
  syncOwner(true);
  assert.equal(rev(owner), initial, "already-fresh owner must remain unchanged");

  writeFileSync(join(seed, "state.txt"), "two\n", "utf8");
  run("git.exe", ["add", "state.txt"], seed);
  run("git.exe", ["commit", "-m", "advance"], seed);
  run("git.exe", ["push", "origin", "main"], seed);
  const remoteAdvanced = rev(seed);
  assert.notEqual(rev(owner), remoteAdvanced, "owner must start stale for automatic refresh proof");

  syncOwner(true);
  assert.equal(rev(owner), remoteAdvanced, "stale clean owner must fast-forward automatically");

  writeFileSync(join(owner, "owner-only.txt"), "local\n", "utf8");
  run("git.exe", ["add", "owner-only.txt"], owner);
  run("git.exe", ["commit", "-m", "local divergence"], owner);
  const divergentHead = rev(owner);

  writeFileSync(join(seed, "seed-only.txt"), "remote\n", "utf8");
  run("git.exe", ["add", "seed-only.txt"], seed);
  run("git.exe", ["commit", "-m", "remote divergence"], seed);
  run("git.exe", ["push", "origin", "main"], seed);

  const diverged = syncOwner(false);
  assert.match(diverged.stderr, /cannot auto-refresh non-fast-forward state/);
  assert.equal(rev(owner), divergentHead, "failed auto-refresh must preserve divergent local HEAD");

  console.log("PASS deploy_owner_freshness fresh_noop=true stale_auto_fast_forward=true divergence_preserved=true live_remote_query=true");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
