import { open } from "node:fs/promises";
import { join } from "node:path";

export const BOOTSTRAP_PROCESS_ALIAS = "bootstrap";
const LEGACY_BOOTSTRAP_PROCESS_ID = "231b7e74-4cc8-43d0-9702-fd6dfa2215b3";
const SHARED_POLICY_ALIASES = ["rules", "agents", "contracts", "pre-repo", "shared-policy"] as const;
type SharedPolicyAlias = typeof SHARED_POLICY_ALIASES[number];

export function isBootstrapSnapshot(processId: string): boolean {
  return [BOOTSTRAP_PROCESS_ALIAS, LEGACY_BOOTSTRAP_PROCESS_ID, "timeline", "checkup", ...SHARED_POLICY_ALIASES].includes(processId as never);
}

// Producer-owned files, never client-supplied paths or commands.

function sharedPolicyPath(kind: "rules" | "agents" | "contracts"): string {
  const envKey = kind === "rules" ? "MCP_SHARED_RULES_PATH"
    : kind === "agents" ? "MCP_SHARED_AGENTS_PATH"
    : "MCP_SHARED_CONTRACTS_PATH";
  const configured = process.env[envKey]?.trim();
  if (configured) return configured;
  const userProfile = process.env.USERPROFILE?.trim();
  if (!userProfile) throw new Error(`Shared policy path configuration is required when USERPROFILE is unavailable (${envKey})`);
  const filename = kind === "rules" ? "RULES.md" : kind === "agents" ? "AGENTS.md" : "CONTRACTS.json";
  return join(userProfile, ".agents", filename);
}

async function readBoundedText(path: string, label: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > 64 * 1024) throw new Error(`${label} exceeds 64 KiB fixed-file limit`);
    return buffer.subarray(0, bytes).toString("utf8").replace(/^\uFEFF/, "");
  } finally { await file.close(); }
}

function isSharedPolicyAlias(processId: string): processId is SharedPolicyAlias {
  return SHARED_POLICY_ALIASES.includes(processId as SharedPolicyAlias);
}

async function readSharedPolicyAlias(processId: SharedPolicyAlias, maxChars: number, startedAt: number): Promise<Record<string, unknown>> {
  let stdout: string;
  let sources: string[];
  if (processId === "pre-repo" || processId === "shared-policy") {
    const [rules, agents] = await Promise.all([
      readBoundedText(sharedPolicyPath("rules"), "RULES.md"),
      readBoundedText(sharedPolicyPath("agents"), "AGENTS.md"),
    ]);
    stdout = `===== RULES.md =====\n${rules}\n\n===== AGENTS.md =====\n${agents}`;
    sources = ["RULES.md", "AGENTS.md"];
  } else {
    const kind = processId as "rules" | "agents" | "contracts";
    const label = kind === "rules" ? "RULES.md" : kind === "agents" ? "AGENTS.md" : "CONTRACTS.json";
    stdout = await readBoundedText(sharedPolicyPath(kind), label);
    sources = [label];
  }
  if (stdout.length > maxChars) throw new Error(`Shared policy exceeds requested max_chars=${maxChars}; no partial policy returned`);
  return {
    mcp_status: "OK", process_state: "SNAPSHOT", elapsed_ms: performance.now() - startedAt,
    next_action: "STOP_READING", process_id: processId, running: false, stdout, stderr: "",
    snapshot_alias: true, shared_policy_alias: true, read_mode: "FIXED_SHARED_POLICY_FILES", sources,
  };
}

function snapshotPath(timeline: boolean): string {
  const configured = process.env[timeline ? "MCP_TIMELINE_SNAPSHOT_PATH" : "MCP_BOOTSTRAP_SNAPSHOT_PATH"]?.trim();
  if (configured) return configured;
  const userProfile = process.env.USERPROFILE?.trim();
  if (!userProfile) throw new Error("Snapshot path configuration is required when USERPROFILE is unavailable");
  return timeline
    ? join(userProfile, "Desktop", "vault", ".state", "timeline", "bootstrap-memory-overview.json")
    : join(userProfile, "Desktop", "vault", ".state", "bootstrap", "latest.json");
}

export async function readBootstrapSnapshot(maxChars = 32_000, processId = BOOTSTRAP_PROCESS_ALIAS): Promise<Record<string, unknown>> {
  const startedAt = performance.now();
  if (isSharedPolicyAlias(processId)) return readSharedPolicyAlias(processId, maxChars, startedAt);
  const timeline = processId === "timeline";
  const alias = timeline ? "timeline" : processId === "checkup" ? "checkup" : BOOTSTRAP_PROCESS_ALIAS;
  let payload;
  // Bounded asynchronous file read: no subprocess, network probe, or refresh on reads.
  const file = await open(snapshotPath(timeline), "r");
  try {
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > 64 * 1024) throw new Error("Snapshot exceeds 64 KiB producer limit");
    payload = JSON.parse(buffer.subarray(0, bytes).toString("utf8").replace(/^\uFEFF/, ""));
  } finally { await file.close(); }
  const generatedAt = Date.parse(payload?.generated_at);
  if (payload?.schema !== (timeline ? "vault.timeline.bootstrap.v1" : "bootstrap.v1")
      || !Number.isFinite(generatedAt) || generatedAt > Date.now() + 5_000
      || (!timeline && (payload?.bootstrap_end?.status !== "COMPLETE" || payload?.bootstrap_end?.schema !== "bootstrap.v1"))) {
    throw new Error("Snapshot producer returned incomplete or invalid payload");
  }
  const ageSeconds = Math.max(0, (Date.now() - generatedAt) / 1000);
  const configuredRefresh = Number(payload.overview?.timeline_materialized?.refresh_minutes);
  const refreshMinutes = Number.isFinite(configuredRefresh) && configuredRefresh >= 1 ? configuredRefresh : 5;
  const staleAfterSeconds = timeline ? Math.max(900, refreshMinutes * 180) : 90;
  const stale = ageSeconds > staleAfterSeconds;
  const freshness = { status: stale ? "STALE" : "FRESH", as_of: payload.generated_at,
    age_seconds: ageSeconds, stale_after_seconds: staleAfterSeconds, read_mode: "MATERIALIZED_ONLY" };
  if (timeline && payload.overview?.timeline_materialized) {
    Object.assign(payload.overview.timeline_materialized, freshness);
    if (stale) payload.overview.timeline_materialized.absence_semantics = "NO_MATCH_IS_NOT_PROOF_OF_ABSENCE";
  }
  const stdout = JSON.stringify(payload);
  if (stdout.length > maxChars) throw new Error(`Snapshot exceeds requested max_chars=${maxChars}; no partial snapshot returned`);
  return {
    mcp_status: stale ? "STALE" : "OK", process_state: "SNAPSHOT", elapsed_ms: performance.now() - startedAt,
    next_action: "STOP_READING", process_id: alias, running: false,
    stdout, stderr: "", generated_at: payload.generated_at, freshness,
    snapshot_alias: true, ...(timeline ? {} : { bootstrap_alias: true }),
  };
}
