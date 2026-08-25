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

import { fork } from "node:child_process";
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
rmSync(STORE, { force: true });

console.log(failures ? `\nCONCURRENCY TEST FAILED (${failures})` : "\nCONCURRENCY TEST PASSED");
process.exit(failures ? 1 : 0);
