// Cross-process concurrency test for the BUSY store.
//
// Runs N separate OS processes that all claim distinct scopes against one store file at
// the same moment. Without a lock this is a lost-update race: each process does
// read-modify-write, so late writers overwrite earlier claims and some vanish.
//
// Also asserts the mutual-exclusion property itself: many processes racing for the SAME
// scope must produce exactly one winner.
//
// Usage: node scripts/concurrency-busy.mjs [workers]

import { fork, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const STORE = resolve(ROOT, ".state/concurrency-test-claims.json");
const { BusyStore } = await import(resolve(ROOT, "dist/lib/busy-store.js").replace(/\\/g, "/").replace(/^/, "file:///"));

// ---- worker mode -----------------------------------------------------------------
if (process.argv[2] === "worker") {
  const scope = process.argv[3];
  const actor = process.argv[4];
  const store = new BusyStore(() => false, STORE);
  try {
    const result = await store.claim(actor, scope);
    process.stdout.write(JSON.stringify({ ok: true, claimed: result.ok, actor, scope }));
    process.exit(0);
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(error?.message || error), errorName: error?.name, actor, scope }));
    process.exit(0);
  }
}

// ---- parent mode -----------------------------------------------------------------
const N = Number(process.argv[2] || 16);
let failures = 0;
const check = (cond, label, detail) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${cond ? "" : `\n         ${detail}`}`);
  if (!cond) failures++;
};

function resetStore() {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify({ claims: [] }, null, 2) + "\n", "utf8");
  for (const stray of [`${STORE}.lock`]) if (existsSync(stray)) rmSync(stray, { force: true });
}

function runWorkers(specs) {
  return Promise.all(specs.map(({ scope, actor }) => new Promise((res) => {
    const child = fork(fileURLToPath(import.meta.url), ["worker", scope, actor], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("exit", () => { try { res(JSON.parse(out)); } catch { res({ ok: false, error: out.slice(0, 200) }); } });
  })));
}

// Test 1: N processes, N distinct scopes. All must survive.
console.log(`test 1 - ${N} processes claiming ${N} distinct scopes simultaneously`);
resetStore();
const distinct = Array.from({ length: N }, (_, i) => ({ scope: `scope-${i}`, actor: `actor-${i}` }));
const t1 = Date.now();
const r1 = await runWorkers(distinct);
const errored = r1.filter((r) => !r.ok);
const persisted = JSON.parse(readFileSync(STORE, "utf8")).claims;
const missing = distinct.filter((d) => !persisted.some((c) => c.scope === d.scope)).map((d) => d.scope);
console.log(`  ${N} workers finished in ${Date.now() - t1}ms; ${persisted.length}/${N} claims persisted`);
check(errored.length === 0, "no worker errored", JSON.stringify(errored.slice(0, 3)));
check(missing.length === 0, `all ${N} claims survived (no lost update)`, `missing: ${missing.join(", ")}`);

// Test 2: N processes, ONE scope. Exactly one winner.
console.log(`\ntest 2 - ${N} processes racing for the SAME scope`);
resetStore();
const same = Array.from({ length: N }, (_, i) => ({ scope: "contested", actor: `actor-${i}` }));
const r2 = await runWorkers(same);
const winners = r2.filter((r) => r.ok && r.claimed);
const finalClaims = JSON.parse(readFileSync(STORE, "utf8")).claims;
console.log(`  winners=${winners.length} losers=${r2.length - winners.length} claims_on_disk=${finalClaims.length}`);
check(winners.length === 1, "exactly one process won the scope", `winners: ${winners.map((w) => w.actor).join(", ")}`);
check(finalClaims.length === 1, "exactly one claim on disk", JSON.stringify(finalClaims));
check(finalClaims[0]?.actor === winners[0]?.actor, "the winner is the actor recorded on disk", `${winners[0]?.actor} vs ${finalClaims[0]?.actor}`);

// Test 3: a stale lock must not wedge the store forever.
console.log(`\ntest 3 - stale lock is reclaimed, not waited on forever`);
resetStore();
writeFileSync(`${STORE}.lock`, "99999", "utf8");
const staleTime = new Date(Date.now() - 60_000);
const { utimesSync } = await import("node:fs");
utimesSync(`${STORE}.lock`, staleTime, staleTime);
const t3 = Date.now();
const r3 = await runWorkers([{ scope: "after-stale-lock", actor: "recoverer" }]);
const ms3 = Date.now() - t3;
check(r3[0]?.ok && r3[0]?.claimed, `claim succeeded despite a stale lock (${ms3}ms)`, JSON.stringify(r3[0]));

// Test 4: a FRESH lock held by someone else fails fast rather than hanging.
console.log(`\ntest 4 - a live lock fails fast instead of hanging`);
resetStore();
writeFileSync(`${STORE}.lock`, "99999", "utf8");
const t4 = Date.now();
const r4 = await runWorkers([{ scope: "blocked", actor: "blocked-actor" }]);
const ms4 = Date.now() - t4;
check(r4[0]?.ok === false, "claim reported an error rather than succeeding", JSON.stringify(r4[0]));
check(r4[0]?.errorName === "BusyStoreLockError", "claim reported the named lock error", JSON.stringify(r4[0]));
check(ms4 < 5000, `failed fast in ${ms4}ms (no hang)`, `took ${ms4}ms`);
rmSync(`${STORE}.lock`, { force: true });

// Test 5: arbitrary task scopes survive the five-minute stale window. Only scopes that
// explicitly opt into session:/process: lifecycle ownership may be auto-pruned.
console.log(`\ntest 5 - long-lived task claims persist; ephemeral lifecycle claims expire`);
resetStore();
const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
writeFileSync(STORE, JSON.stringify({ claims: [
  { actor: "long-worker", scope: "task:long-running-integration", timestamp: oldTimestamp },
  { actor: "old-session", scope: "session:gone-session", timestamp: oldTimestamp },
  { actor: "old-process", scope: "process:00000000-0000-0000-0000-000000000000", timestamp: oldTimestamp },
] }, null, 2) + "\n", "utf8");
const durabilityStore = new BusyStore(() => false, STORE);
const durableClaims = await durabilityStore.list();
check(durableClaims.some((claim) => claim.scope === "task:long-running-integration"), "ordinary task claim survives >5 minutes", JSON.stringify(durableClaims));
check(!durableClaims.some((claim) => claim.scope === "session:gone-session"), "dead session claim is pruned", JSON.stringify(durableClaims));
check(!durableClaims.some((claim) => claim.scope.startsWith("process:")), "dead process claim is pruned", JSON.stringify(durableClaims));
rmSync(STORE, { force: true });

// Test 6: top-level coordinator metadata survives legacy BUSY mutations. This is the
// compatibility seam that lets the standalone coordinator enrich the same canonical
// state file before the MCP BUSY tools are retired.
console.log(`\ntest 6 - unknown top-level coordinator metadata survives claim/release`);
resetStore();
writeFileSync(STORE, JSON.stringify({ version: 2, coordinator: { jobs: { alpha: { state: "blocked", checkpoint: "issue#125" } } }, claims: [] }, null, 2) + "\n", "utf8");
const compatibilityStore = new BusyStore(() => false, STORE);
await compatibilityStore.claim("compat-worker", "task:compat");
let compatibilityRaw = JSON.parse(readFileSync(STORE, "utf8"));
check(compatibilityRaw.version === 2, "top-level version survives claim", JSON.stringify(compatibilityRaw));
check(compatibilityRaw.coordinator?.jobs?.alpha?.checkpoint === "issue#125", "coordinator metadata survives claim", JSON.stringify(compatibilityRaw));
await compatibilityStore.release("compat-worker", "task:compat");
compatibilityRaw = JSON.parse(readFileSync(STORE, "utf8"));
check(compatibilityRaw.coordinator?.jobs?.alpha?.state === "blocked", "coordinator metadata survives release", JSON.stringify(compatibilityRaw));
rmSync(STORE, { force: true });

// Test 7: Windows readers may allow read/write but deny delete sharing. In that
// state rename/replace fails even though an in-place write is legal.
if (process.platform === "win32") {
  console.log(`\ntest 7 - Windows reader without delete sharing does not block claim/release`);
  resetStore();
  const ps = [
    "$p=$env:BUSY_TEST_STORE",
    "$f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)",
    "[Console]::Out.WriteLine('LOCKED')",
    "try { Start-Sleep -Seconds 20 } finally { $f.Dispose() }",
  ].join("; ");
  const holder = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], {
    env: { ...process.env, BUSY_TEST_STORE: STORE }, stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error("reader lock setup timed out")), 5_000);
    let stdout = "";
    holder.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes("LOCKED")) { clearTimeout(timeout); resolveReady(); }
    });
    holder.once("exit", (code) => { clearTimeout(timeout); rejectReady(new Error(`reader exited before lock setup: ${code}`)); });
  });
  try {
    const sharingStore = new BusyStore(() => false, STORE);
    const claimed = await sharingStore.claim("windows-reader-worker", "task:reader-held");
    check(claimed.ok, "claim succeeds while reader denies delete sharing", JSON.stringify(claimed));
    let sharingRaw = JSON.parse(readFileSync(STORE, "utf8"));
    check(sharingRaw.claims?.some((claim) => claim.actor === "windows-reader-worker" && claim.scope === "task:reader-held"), "claim is persisted on disk", JSON.stringify(sharingRaw));
    const released = await sharingStore.release("windows-reader-worker", "task:reader-held");
    check(released.ok, "release succeeds while reader denies delete sharing", JSON.stringify(released));
    sharingRaw = JSON.parse(readFileSync(STORE, "utf8"));
    check(sharingRaw.claims?.length === 0, "release is persisted on disk", JSON.stringify(sharingRaw));
  } finally {
    holder.kill();
    await new Promise((resolveExit) => holder.once("exit", resolveExit));
    rmSync(STORE, { force: true });
  }
}

console.log(failures ? `\nCONCURRENCY TEST FAILED (${failures})` : "\nCONCURRENCY TEST PASSED");
process.exit(failures ? 1 : 0);
