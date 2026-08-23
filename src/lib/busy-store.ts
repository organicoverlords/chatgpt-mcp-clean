import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type BusyClaim = {
  actor: string;
  scope: string;
  timestamp: string;
};

const STALE_AFTER_MS = 5 * 60 * 1000;

type BusyFile = { claims: BusyClaim[] };

export class BusyStore {
  private readonly claims = new Map<string, BusyClaim>();
  private readonly storePath: string;

  constructor(
    private readonly hasLiveReference: (scope: string) => boolean,
    storePath = process.env.MCP_BUSY_STORE_PATH || ".state/busy-claims.json",
  ) {
    this.storePath = resolve(storePath);
    this.load();
    this.prune();
  }

  claim(actor: string, scope: string): { ok: true; claim: BusyClaim } | { ok: false; reason: string; claim: BusyClaim } {
    this.refresh();
    const current = this.claims.get(scope);
    if (current && current.actor !== actor) return { ok: false, reason: "scope_already_claimed", claim: current };
    const claim = { actor, scope, timestamp: new Date().toISOString() };
    this.claims.set(scope, claim);
    this.persist();
    return { ok: true, claim };
  }

  list(): BusyClaim[] {
    this.refresh();
    return [...this.claims.values()].sort((left, right) => left.scope.localeCompare(right.scope));
  }

  release(actor: string, scope: string): { ok: true; released: BusyClaim } | { ok: false; reason: string; claim?: BusyClaim } {
    this.refresh();
    const current = this.claims.get(scope);
    if (!current) return { ok: false, reason: "scope_not_claimed" };
    if (current.actor !== actor) return { ok: false, reason: "claim_belongs_to_another_actor", claim: current };
    this.claims.delete(scope);
    this.persist();
    return { ok: true, released: current };
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
