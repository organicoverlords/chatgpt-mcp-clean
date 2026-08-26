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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isAutoPrunableScope(scope: string): boolean {
  return scope.startsWith("session:") || scope.startsWith("process:");
}

export class BusyStore {
  private readonly claims = new Map<string, BusyClaim>();
  private readonly storePath: string;

  constructor(
    private readonly hasLiveReference: (scope: string) => boolean,
    storePath = process.env.MCP_BUSY_STORE_PATH || ".state/busy-claims.json",
  ) {
    this.storePath = resolve(storePath);
    // Do not acquire the inter-process lock during construction. The first operation
    // refreshes under the lock, and startup must never wait on another writer.
  }

  async claim(actor: string, scope: string): Promise<{ ok: true; claim: BusyClaim } | { ok: false; reason: string; claim: BusyClaim }> {
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

  async list(): Promise<BusyClaim[]> {
    // Also locked: refresh() calls prune(), which can persist(), so listing is a
    // read-modify-write like the others.
    return this.withLock(() => {
      this.refresh();
      return [...this.claims.values()].sort((left, right) => left.scope.localeCompare(right.scope));
    });
  }

  async release(actor: string, scope: string): Promise<{ ok: true; released: BusyClaim } | { ok: false; reason: string; claim?: BusyClaim }> {
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
  // BUSY forever, and every holder here does bounded file IO. Waiting for a competing
  // writer must yield the Node event loop so health and unrelated tools remain responsive.
  private async withLock<T>(fn: () => T | PromiseLike<T>, timeoutMs = LOCK_TIMEOUT_MS): Promise<T> {
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
        await sleep(LOCK_RETRY_MS);
      }
    }

    try {
      try { writeSync(fd, String(process.pid)); } catch {}
      return await fn();
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
      // Ordinary task scopes are durable coordination state and must survive long runs,
      // tool-context rollovers, and listener reconnects until their actor explicitly releases
      // them. Only scopes that opt into lifecycle ownership with session:/process: may expire.
      if (isAutoPrunableScope(scope) && now - Date.parse(claim.timestamp) > STALE_AFTER_MS && !this.hasLiveReference(scope)) {
        this.claims.delete(scope);
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}
