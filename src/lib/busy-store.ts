import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type BusyClaim = {
  actor: string;
  scope: string;
  timestamp: string;
};

const STALE_AFTER_MS = 5 * 60 * 1000;

// Lock tuning. The timeout is deliberately short: a claim that cannot get the lock must
// fail fast with a clear error, never block a tool call. Waiting is the failure mode we
// are trying to eliminate, not an acceptable outcome.
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 15_000;
const LOCK_RETRY_MS = 10;

// Atomics.wait needs a SharedArrayBuffer; this is the only way to sleep synchronously,
// and BusyStore's API is synchronous.
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

type BusyFile = { claims: BusyClaim[] };

export class BusyStoreLockError extends Error {
  constructor() {
    super(`busy store is locked by another writer; gave up after ${LOCK_TIMEOUT_MS}ms`);
    this.name = "BusyStoreLockError";
  }
}

function isLockContentionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EEXIST" || code === "EACCES" || code === "EPERM";
}

export class BusyStore {
  private readonly claims = new Map<string, BusyClaim>();
  private readonly storePath: string;

  constructor(
    private readonly hasLiveReference: (scope: string) => boolean,
    storePath = process.env.MCP_BUSY_STORE_PATH || ".state/busy-claims.json",
  ) {
    this.storePath = resolve(storePath);
    // Best-effort at boot. If another writer holds the lock right now, start with an
    // empty map and let the first operation refresh under the lock -- never fail server
    // startup over the busy store.
    try {
      this.withLock(() => {
        this.load();
        this.prune();
      }, 0);
    } catch {
      // ignore
    }
  }

  claim(actor: string, scope: string): { ok: true; claim: BusyClaim } | { ok: false; reason: string; claim: BusyClaim } {
    return this.withLock(() => {
      this.refresh();
      const current = this.claims.get(scope);
      if (current && current.actor !== actor) return { ok: false as const, reason: "scope_already_claimed", claim: current };
      const claim = { actor, scope, timestamp: new Date().toISOString() };
      this.claims.set(scope, claim);
      this.persist();
      return { ok: true as const, claim };
    });
  }

  list(): BusyClaim[] {
    // Also locked: refresh() calls prune(), which can persist(), so listing is a
    // read-modify-write like the others.
    return this.withLock(() => {
      this.refresh();
      return [...this.claims.values()].sort((left, right) => left.scope.localeCompare(right.scope));
    });
  }

  release(actor: string, scope: string): { ok: true; released: BusyClaim } | { ok: false; reason: string; claim?: BusyClaim } {
    return this.withLock(() => {
      this.refresh();
      const current = this.claims.get(scope);
      if (!current) return { ok: false as const, reason: "scope_not_claimed" };
      if (current.actor !== actor) return { ok: false as const, reason: "claim_belongs_to_another_actor", claim: current };
      this.claims.delete(scope);
      this.persist();
      return { ok: true as const, released: current };
    });
  }

  // Cross-process mutual exclusion for the read-modify-write cycle.
  //
  // Re-reading before each operation fixed divergence between writers, but two writers
  // landing together could still interleave and lose a claim. O_EXCL creation is atomic
  // on Windows and POSIX alike, so the lock file is the arbiter.
  //
  // A lock older than LOCK_STALE_MS is stolen: a process killed mid-write must not wedge
  // BUSY forever, and every holder here does bounded synchronous file IO.
  private withLock<T>(fn: () => T, timeoutMs = LOCK_TIMEOUT_MS): T {
    const lockPath = `${this.storePath}.lock`;
    mkdirSync(dirname(this.storePath), { recursive: true });
    const deadline = Date.now() + timeoutMs;
    let fd: number | undefined;

    for (;;) {
      try {
        fd = openSync(lockPath, "wx");
        break;
      } catch (error) {
        // Windows can report EACCES or EPERM instead of EEXIST when another
        // process still has the O_EXCL lock open. They are contention signals,
        // not permanent store failures.
        if (!isLockContentionError(error)) throw error;
        let reclaimed = false;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
            unlinkSync(lockPath);
            reclaimed = true;
          }
        } catch (staleError) {
          const code = (staleError as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") continue; // holder released it before our stat
          if (!isLockContentionError(staleError)) throw staleError;
        }
        if (reclaimed) continue;
        if (Date.now() >= deadline) {
          throw new BusyStoreLockError();
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }

    try {
      try { writeSync(fd, String(process.pid)); } catch {}
      return fn();
    } finally {
      try { closeSync(fd); } catch {}
      try { unlinkSync(lockPath); } catch {}
    }
  }

  // Re-read the store before every operation, then prune.
  //
  // load() used to run only in the constructor, so the in-memory map was treated as
  // authoritative for the process lifetime and persist() blind-overwrote the file.
  // Any claim written by another writer -- a second server instance, or an agent on a
  // fallback path writing busy-claims.json directly -- was invisible to this process
  // and was destroyed by the next persist(). For a mutual-exclusion primitive that is
  // the worst failure available: two workers hold one scope and the evidence is erased.
  // Observed live: a claim by chatgpt-orchestrator was absent from busy_list and then
  // silently overwritten.
  private refresh(): void {
    this.load();
    this.prune();
  }

  // Replaces the in-memory map rather than merging into it, so a release performed by
  // another writer is not resurrected here. A missing file means "no claims"; any other
  // read/parse failure leaves the current map untouched, so a transient IO error or a
  // torn read cannot silently drop live claims.
  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.storePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") this.claims.clear();
      return;
    }
    let parsed: Partial<BusyFile>;
    try {
      parsed = JSON.parse(raw) as Partial<BusyFile>;
    } catch {
      return;
    }
    if (!Array.isArray(parsed.claims)) return;
    const next = new Map<string, BusyClaim>();
    for (const claim of parsed.claims) {
      if (!claim || typeof claim.actor !== "string" || typeof claim.scope !== "string" || typeof claim.timestamp !== "string") continue;
      if (!Number.isFinite(Date.parse(claim.timestamp))) continue;
      next.set(claim.scope, claim);
    }
    this.claims.clear();
    for (const [scope, claim] of next) this.claims.set(scope, claim);
  }

  private persist(): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify({ claims: [...this.claims.values()] }, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.storePath);
  }

  private prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [scope, claim] of this.claims) {
      if (now - Date.parse(claim.timestamp) > STALE_AFTER_MS && !this.hasLiveReference(scope)) {
        this.claims.delete(scope);
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}
