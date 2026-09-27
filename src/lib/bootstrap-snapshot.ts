import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";

export const BOOTSTRAP_PROCESS_ALIAS = "bootstrap";
const LEGACY_BOOTSTRAP_PROCESS_ID = "231b7e74-4cc8-43d0-9702-fd6dfa2215b3";
const SNAPSHOT_PAGE_MAX_CHARS = 256_000;
const TIMELINE_SNAPSHOT_MAX_BYTES = 64 * 1024;
const SNAPSHOT_PAGE_SESSION_TTL_MS = 30 * 60 * 1000;
const SNAPSHOT_PAGE_MAX_SESSIONS = 128;

type SnapshotFreshness = {
  status: "FRESH" | "STALE";
  as_of: string;
  age_seconds: number;
  stale_after_seconds: number;
  read_mode: "MATERIALIZED_ONLY" | "V3_DIRECT_READ";
};

type SnapshotPageBase = {
  mcp_status: "OK" | "STALE";
  process_state: "SNAPSHOT";
  process_id: string;
  running: false;
  generated_at: string;
  freshness: SnapshotFreshness;
  snapshot_alias: true;
  bootstrap_alias?: true;
};

type SnapshotPageSession = {
  base: SnapshotPageBase;
  stdout: string;
  offset: number;
  lastAccessMs: number;
};

const snapshotPageSessions = new Map<string, SnapshotPageSession>();

export function isBootstrapSnapshot(processId: string): boolean {
  return [BOOTSTRAP_PROCESS_ALIAS, LEGACY_BOOTSTRAP_PROCESS_ID, "timeline", "checkup"].includes(processId);
}

function snapshotAlias(processId: string): string {
  if (processId === "timeline") return "timeline";
  if (processId === "checkup") return "checkup";
  return BOOTSTRAP_PROCESS_ALIAS;
}

function snapshotSessionKey(alias: string, callerId: string): string {
  return alias + ":" + (callerId || "caller_unknown");
}

function pruneSnapshotPageSessions(now = Date.now()): void {
  for (const [key, session] of snapshotPageSessions) {
    if (now - session.lastAccessMs > SNAPSHOT_PAGE_SESSION_TTL_MS) snapshotPageSessions.delete(key);
  }
  if (snapshotPageSessions.size < SNAPSHOT_PAGE_MAX_SESSIONS) return;
  const removeCount = snapshotPageSessions.size - SNAPSHOT_PAGE_MAX_SESSIONS + 1;
  const oldest = [...snapshotPageSessions.entries()]
    .sort((a, b) => a[1].lastAccessMs - b[1].lastAccessMs)
    .slice(0, removeCount);
  for (const [key] of oldest) snapshotPageSessions.delete(key);
}

const BOOTSTRAP_ENVELOPE_SECTIONS = ["conversation", "working_order", "current", "history_and_health", "plumbing", "other_roots"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bootstrapRoot(payload: unknown, key: string): unknown {
  if (!isRecord(payload)) return undefined;
  const matches: unknown[] = [];
  if (Object.prototype.hasOwnProperty.call(payload, key)) matches.push(payload[key]);
  const orientation = isRecord(payload.orientation) ? payload.orientation : undefined;
  const envelope = orientation && BOOTSTRAP_ENVELOPE_SECTIONS.some(section => Object.prototype.hasOwnProperty.call(orientation, section));
  if (envelope && orientation) {
    for (const section of BOOTSTRAP_ENVELOPE_SECTIONS) {
      const values = orientation[section];
      if (values === undefined || values === null) continue;
      if (!isRecord(values)) throw new Error(`Snapshot producer returned invalid bootstrap envelope section=${section}`);
      if (Object.prototype.hasOwnProperty.call(values, key)) matches.push(values[key]);
    }
  }
  if (matches.length > 1) throw new Error(`Snapshot producer returned ambiguous bootstrap envelope root=${key}`);
  return matches[0];
}

// Timeline remains a materialized read-only product. The bootstrap alias delegates
// directly to the current V3 producer so one canonical bootstrap name has one truth.
function timelineSnapshotPath(): string {
  const configured = process.env.MCP_TIMELINE_SNAPSHOT_PATH?.trim();
  if (configured) return configured;
  const userProfile = process.env.USERPROFILE?.trim();
  if (!userProfile) throw new Error("Timeline snapshot path configuration is required when USERPROFILE is unavailable");
  return join(userProfile, "Desktop", "vault", ".state", "timeline", "bootstrap-memory-overview.json");
}

function v3BootstrapCommand(): { executable: string; cwd?: string } {
  const configuredExecutable = process.env.MCP_V3_BOOTSTRAP_EXECUTABLE?.trim();
  const configuredCwd = process.env.MCP_V3_BOOTSTRAP_CWD?.trim();
  if (configuredExecutable) return { executable: configuredExecutable, ...(configuredCwd ? { cwd: configuredCwd } : {}) };
  const userProfile = process.env.USERPROFILE?.trim();
  if (!userProfile) return { executable: "v3-rust" };
  return {
    executable: join(userProfile, ".local", "bin", process.platform === "win32" ? "v3-rust.exe" : "v3-rust"),
    cwd: configuredCwd || join(userProfile, ".agents"),
  };
}

async function currentV3BootstrapPayload(): Promise<Record<string, unknown>> {
  const { executable, cwd } = v3BootstrapCommand();
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      ["bootstrap", "--view", "readable"],
      { ...(cwd ? { cwd } : {}), windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (error, childStdout, childStderr) => {
        if (error) {
          reject(new Error("V3 bootstrap producer failed: " + error.message + "; stderr=" + String(childStderr).slice(0, 4000)));
          return;
        }
        resolve(String(childStdout));
      },
    );
  });
  const payload = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  if (!isRecord(payload)) throw new Error("V3 bootstrap producer returned a non-object payload");
  return payload;
}

function pageSnapshot(
  session: SnapshotPageSession,
  key: string,
  requestedChars: number,
  startedAt: number,
): Record<string, unknown> {
  const pageLimit = Math.max(1, Math.min(requestedChars, SNAPSHOT_PAGE_MAX_CHARS));
  const start = session.offset;
  const end = Math.min(session.stdout.length, start + pageLimit);
  const more = end < session.stdout.length;
  session.offset = end;
  session.lastAccessMs = Date.now();
  if (more) snapshotPageSessions.set(key, session);
  else snapshotPageSessions.delete(key);
  return {
    ...session.base,
    elapsed_ms: performance.now() - startedAt,
    next_action: more ? "READ_SAME_PROCESS_ID" : "STOP_READING",
    stdout: session.stdout.slice(start, end),
    stderr: "",
    output_page: {
      stdout_start: start,
      stdout_end: end,
      stdout_total: session.stdout.length,
      stderr_start: 0,
      stderr_end: 0,
      stderr_total: 0,
      page_chars: end - start,
      page_limit: pageLimit,
      more,
    },
  };
}

export async function readBootstrapSnapshot(
  maxChars = 256_000,
  processId = BOOTSTRAP_PROCESS_ALIAS,
  callerId = "caller_unknown",
): Promise<Record<string, unknown>> {
  const startedAt = performance.now();
  const alias = snapshotAlias(processId);
  const key = snapshotSessionKey(alias, callerId);
  pruneSnapshotPageSessions();
  const existing = snapshotPageSessions.get(key);
  if (existing) return pageSnapshot(existing, key, maxChars, startedAt);

  const timeline = alias === "timeline";
  let payload;
  if (!timeline) {
    payload = await currentV3BootstrapPayload();
  } else {
    // Timeline remains independently bounded because it is a different materialized product.
    const file = await open(timelineSnapshotPath(), "r");
    try {
      const buffer = Buffer.alloc(TIMELINE_SNAPSHOT_MAX_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await file.read(buffer, bytes, buffer.length - bytes, null);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      if (bytes > TIMELINE_SNAPSHOT_MAX_BYTES) throw new Error(`Timeline snapshot exceeds ${TIMELINE_SNAPSHOT_MAX_BYTES / 1024} KiB producer limit`);
      payload = JSON.parse(buffer.subarray(0, bytes).toString("utf8").replace(/^\uFEFF/, ""));
    } finally { await file.close(); }
  }
  const generatedAt = Date.parse(String(payload.generated_at ?? ""));
  const bootstrapEnd = timeline ? undefined : bootstrapRoot(payload, "bootstrap_end");
  const v3Bootstrap = payload.schema === "v3-rust.bootstrap.v1";
  const v3Coverage = v3Bootstrap && isRecord(payload.coverage) ? payload.coverage : undefined;
  if ((timeline ? payload.schema !== "vault.timeline.bootstrap.v1" : !v3Bootstrap)
      || !Number.isFinite(generatedAt) || generatedAt > Date.now() + 5_000
      || (!timeline && (!isRecord(bootstrapEnd) || bootstrapEnd.status !== "COMPLETE" || bootstrapEnd.schema !== payload.schema))
      || (v3Bootstrap && (!v3Coverage || v3Coverage.status !== "COMPLETE" || v3Coverage.exact_user_text !== true
        || (v3Coverage.user_message_age_stripping !== false && v3Coverage.age_stripping !== false)))) {
    throw new Error("Snapshot producer returned incomplete or invalid payload");
  }
  const ageSeconds = Math.max(0, (Date.now() - generatedAt) / 1000);
  const configuredRefresh = Number(payload.overview?.timeline_materialized?.refresh_minutes);
  const refreshMinutes = Number.isFinite(configuredRefresh) && configuredRefresh >= 1 ? configuredRefresh : 5;
  const staleAfterSeconds = timeline ? Math.max(900, refreshMinutes * 180) : 90;
  const stale = ageSeconds > staleAfterSeconds;
  const freshness: SnapshotFreshness = { status: stale ? "STALE" : "FRESH", as_of: String(payload.generated_at),
    age_seconds: ageSeconds, stale_after_seconds: staleAfterSeconds, read_mode: timeline ? "MATERIALIZED_ONLY" : "V3_DIRECT_READ" };
  if (timeline && payload.overview?.timeline_materialized) {
    Object.assign(payload.overview.timeline_materialized, freshness);
    if (stale) payload.overview.timeline_materialized.absence_semantics = "NO_MATCH_IS_NOT_PROOF_OF_ABSENCE";
  }
  const stdout = JSON.stringify(payload, null, 2);
  const base: SnapshotPageBase = {
    mcp_status: stale ? "STALE" : "OK",
    process_state: "SNAPSHOT",
    process_id: alias,
    running: false,
    generated_at: String(payload.generated_at),
    freshness,
    snapshot_alias: true,
    ...(timeline ? {} : { bootstrap_alias: true }),
  };
  const pageLimit = Math.max(1, Math.min(maxChars, SNAPSHOT_PAGE_MAX_CHARS));
  if (stdout.length <= pageLimit) {
    return {
      ...base,
      elapsed_ms: performance.now() - startedAt,
      next_action: "STOP_READING",
      stdout,
      stderr: "",
    };
  }
  const session: SnapshotPageSession = { base, stdout, offset: 0, lastAccessMs: Date.now() };
  pruneSnapshotPageSessions();
  snapshotPageSessions.set(key, session);
  return pageSnapshot(session, key, maxChars, startedAt);
}
