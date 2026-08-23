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
    this.prune();
    const current = this.claims.get(scope);
    if (current && current.actor !== actor) return { ok: false, reason: "scope_already_claimed", claim: current };
    const claim = { actor, scope, timestamp: new Date().toISOString() };
    this.claims.set(scope, claim);
    this.persist();
    return { ok: true, claim };
  }

  list(): BusyClaim[] {
    this.prune();
    return [...this.claims.values()].sort((left, right) => left.scope.localeCompare(right.scope));
  }

  release(actor: string, scope: string): { ok: true; released: BusyClaim } | { ok: false; reason: string; claim?: BusyClaim } {
    this.prune();
    const current = this.claims.get(scope);
    if (!current) return { ok: false, reason: "scope_not_claimed" };
    if (current.actor !== actor) return { ok: false, reason: "claim_belongs_to_another_actor", claim: current };
    this.claims.delete(scope);
    this.persist();
    return { ok: true, released: current };
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.storePath, "utf8")) as Partial<BusyFile>;
      if (!Array.isArray(parsed.claims)) return;
      for (const claim of parsed.claims) {
        if (!claim || typeof claim.actor !== "string" || typeof claim.scope !== "string" || typeof claim.timestamp !== "string") continue;
        if (!Number.isFinite(Date.parse(claim.timestamp))) continue;
        this.claims.set(claim.scope, claim);
      }
    } catch {
      // Missing or malformed state starts empty; the next mutation rewrites it.
    }
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
