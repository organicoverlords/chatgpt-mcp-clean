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
function checkOwner(expectFresh) {
  const result = spawnSync("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", guard, "-Root", owner,
  ], { cwd: resolve("."), encoding: "utf8" });
  if (expectFresh) {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FRESH/);
  } else {
    assert.notEqual(result.status, 0, "stale deploy owner must fail closed");
    assert.match(result.stderr, /candidate deploy owner stale/);
  }
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

  checkOwner(true);

  writeFileSync(join(seed, "state.txt"), "two\n", "utf8");
  run("git.exe", ["add", "state.txt"], seed);
  run("git.exe", ["commit", "-m", "advance"], seed);
  run("git.exe", ["push", "origin", "main"], seed);

  checkOwner(false);

  run("git.exe", ["fetch", "origin", "main"], owner);
  run("git.exe", ["merge", "--ff-only", "origin/main"], owner);
  checkOwner(true);

  console.log("PASS deploy_owner_freshness fresh_accept=true remote_advance_rejected=true fast_forward_accept=true live_remote_query=true");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
