import fs from "node:fs";
import readline from "node:readline";
import { basename, join } from "node:path";

const PROCESS_TOOLS = new Set(["start_process", "read_output", "kill_process"]);
const TRANSPORT_ERROR_EVENTS = new Set(["request_error", "connection_error", "http_server_error", "process_uncaught_exception"]);
const ANALYTIC_CLASSIFICATION_MARKERS = ["correction", "counterexample", "correlation"];

function usage() {
  console.error("usage: node scripts/analyze-reroute-acceptance.mjs <transport.jsonl> <routing-events.jsonl> <start-iso> <end-iso> [--bin-minutes N]");
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length < 4) usage();
const [transportInputPath, routingPath, startRaw, endRaw, ...rest] = args;
let binMinutes = 15;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] !== "--bin-minutes" || i + 1 >= rest.length) usage();
  binMinutes = Number(rest[++i]);
}
const startMs = Date.parse(startRaw);
const endMs = Date.parse(endRaw);
if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || !Number.isFinite(binMinutes) || binMinutes <= 0) usage();
const binMs = binMinutes * 60_000;

function increment(map, key, amount = 1) {
  const normalized = String(key ?? "unknown");
  map.set(normalized, (map.get(normalized) ?? 0) + amount);
}

function jsonlFiles(directory) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(directory, entry.name))
    .sort();
}

function boundedArchiveRotationMs(path) {
  const match = basename(path).match(/\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.[^.]+\.jsonl$/);
  if (!match) return null;
  const [, date, hour, minute, second, millis] = match;
  const parsed = Date.parse(`${date}T${hour}:${minute}:${second}.${millis}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function transportPaths(inputPath, windowStartMs) {
  const stat = fs.statSync(inputPath);
  if (!stat.isFile()) throw new Error(`transport input is not a file: ${inputPath}`);
  const archive = `${inputPath}.archive`;
  const paths = [];
  const skippedByRotationTime = [];
  for (const archived of jsonlFiles(archive)) {
    const rotationMs = boundedArchiveRotationMs(archived);
    if (rotationMs !== null && rotationMs < windowStartMs) skippedByRotationTime.push(archived);
    else paths.push(archived);
  }
  paths.push(inputPath);
  return { paths, skippedByRotationTime };
}

function percentileSorted(sorted, fraction) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return Number(sorted[index].toFixed(3));
}

function durationSummary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentileSorted(sorted, 0.50),
    p90: percentileSorted(sorted, 0.90),
    p95: percentileSorted(sorted, 0.95),
    p99: percentileSorted(sorted, 0.99),
    max: sorted.length ? Number(sorted.at(-1).toFixed(3)) : null,
  };
}

function statusObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function perThousand(count, exposure) {
  if (!Number.isFinite(exposure) || exposure <= 0) return null;
  return Number(((count / exposure) * 1000).toFixed(6));
}

function rateObject(map, exposure) {
  return Object.fromEntries([...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => [key, perThousand(count, exposure)]));
}

function isAdverseClassification(value) {
  const classification = String(value ?? "").trim().toLowerCase();
  if (!classification) return false;
  if (ANALYTIC_CLASSIFICATION_MARKERS.some((marker) => classification.includes(marker))) return false;
  return classification.includes("reroute") || classification.includes("block") || classification.includes("thinking_more");
}

function directBlockAttempts(event) {
  const classification = String(event.classification ?? "").toLowerCase();
  if (!classification.includes("block")) return 0;
  const attempts = Number(event?.operation?.attempts_blocked);
  return Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1;
}

function adverseFamily(event) {
  const classification = String(event.classification ?? "").trim().toLowerCase();
  if (!isAdverseClassification(classification)) return null;
  return classification.includes("block") ? "direct_tool_block" : "user_visible_or_above_mcp";
}

function binIndex(atMs) {
  return Math.min(Math.floor((atMs - startMs) / binMs), Math.max(0, Math.ceil((endMs - startMs) / binMs) - 1));
}

function createBin(index) {
  const binStart = startMs + index * binMs;
  const binEnd = Math.min(endMs, binStart + binMs);
  return {
    start: new Date(binStart).toISOString(),
    end: new Date(binEnd).toISOString(),
    process_tool_calls: 0,
    status_200: 0,
    non_2xx: 0,
    transport_errors: 0,
  };
}

const binCount = Math.max(1, Math.ceil((endMs - startMs) / binMs));
const bins = Array.from({ length: binCount }, (_, index) => createBin(index));
const transportEventCounts = new Map();
const methodResponseCounts = new Map();
const methodStatusCounts = new Map();
const non2xxResponseCounts = new Map();
const processByTool = new Map();
const callers = new Set();
const sessions = new Set();
const connections = new Set();
let transportMalformed = 0;
let transportSelected = 0;
let processToolCalls = 0;
let processToolStatus200 = 0;
let processToolNon2xx = 0;
let processFirstAtMs = null;
let processLastAtMs = null;
let transportErrors = 0;

const transportDiscovery = transportPaths(transportInputPath, startMs);
const transportSources = transportDiscovery.paths;
const seenResponseRequests = new Set();
const seenTransportErrors = new Set();
let duplicateResponseRowsSkipped = 0;
let duplicateTransportErrorRowsSkipped = 0;
const sourceCoverage = [];

for (const transportPath of transportSources) {
  let sourceFirstAt = null;
  let sourceLastAt = null;
  let sourceSelected = 0;
  const transportInput = fs.createReadStream(transportPath, { encoding: "utf8" });
  for await (const line of readline.createInterface({ input: transportInput, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { transportMalformed++; continue; }
    const atMs = Date.parse(event.at);
    if (Number.isFinite(atMs)) {
      sourceFirstAt = sourceFirstAt === null ? atMs : Math.min(sourceFirstAt, atMs);
      sourceLastAt = sourceLastAt === null ? atMs : Math.max(sourceLastAt, atMs);
    }
    if (!Number.isFinite(atMs) || atMs < startMs || atMs > endMs) continue;
    transportSelected++;
    sourceSelected++;
    increment(transportEventCounts, event.event ?? "unknown");
    const index = binIndex(atMs);
    if (TRANSPORT_ERROR_EVENTS.has(event.event)) {
      const errorKey = `${event.event}|${event.request_id ?? ""}|${event.connection_id ?? ""}|${event.at ?? ""}`;
      if (seenTransportErrors.has(errorKey)) {
        duplicateTransportErrorRowsSkipped++;
      } else {
        seenTransportErrors.add(errorKey);
        transportErrors++;
        bins[index].transport_errors++;
      }
    }
    if (event.event !== "response_finish") continue;

    const responseKey = event.request_id ? String(event.request_id) : `${event.at}|${event.connection_id ?? ""}|${event.mcp_method ?? ""}|${event.mcp_tool ?? ""}|${event.status ?? ""}`;
    if (seenResponseRequests.has(responseKey)) {
      duplicateResponseRowsSkipped++;
      continue;
    }
    seenResponseRequests.add(responseKey);

    const method = event.mcp_method ?? "non_mcp";
    increment(methodResponseCounts, method);
    increment(methodStatusCounts, `${method}:${event.status ?? "unknown"}`);
    if (Number(event.status) < 200 || Number(event.status) >= 300) {
      increment(non2xxResponseCounts, `${event.status ?? "unknown"}|${method}|${event.mcp_tool ?? "none"}|${event.path ?? "unknown"}`);
    }
    if (event.mcp_method !== "tools/call" || !PROCESS_TOOLS.has(event.mcp_tool)) continue;

    processToolCalls++;
    processFirstAtMs = processFirstAtMs === null ? atMs : Math.min(processFirstAtMs, atMs);
    processLastAtMs = processLastAtMs === null ? atMs : Math.max(processLastAtMs, atMs);
    const status = Number(event.status);
    if (status === 200) {
      processToolStatus200++;
      bins[index].status_200++;
    } else {
      processToolNon2xx++;
      bins[index].non_2xx++;
    }
    bins[index].process_tool_calls++;
    if (event.caller_id) callers.add(event.caller_id);
    if (event.session_id) sessions.add(event.session_id);
    if (event.connection_id) connections.add(event.connection_id);

    const tool = processByTool.get(event.mcp_tool) ?? { total: 0, status_200: 0, non_2xx: 0, durations: [] };
    tool.total++;
    if (status === 200) tool.status_200++; else tool.non_2xx++;
    if (Number.isFinite(event.duration_ms)) tool.durations.push(Number(event.duration_ms));
    processByTool.set(event.mcp_tool, tool);
  }
  sourceCoverage.push({
    file: basename(transportPath),
    first_at: sourceFirstAt === null ? null : new Date(sourceFirstAt).toISOString(),
    last_at: sourceLastAt === null ? null : new Date(sourceLastAt).toISOString(),
    selected_rows: sourceSelected,
  });
}

const knownAdverseClassifications = new Map();
const unknownAdverseReportClassifications = new Map();
const knownAdverseFamilies = new Map();
const unknownAdverseReportFamilies = new Map();
let routingMalformed = 0;
let routingRecords = 0;
let knownAdverseInWindow = 0;
let unknownAdverseReportsInWindow = 0;
let knownDirectBlockAttempts = 0;

const routingInput = fs.createReadStream(routingPath, { encoding: "utf8" });
for await (const line of readline.createInterface({ input: routingInput, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let event;
  try { event = JSON.parse(line); } catch { routingMalformed++; continue; }
  routingRecords++;
  if (!isAdverseClassification(event.classification)) continue;

  const eventTimeMs = event.event_time_known === true ? Date.parse(event.event_time) : NaN;
  if (Number.isFinite(eventTimeMs)) {
    if (eventTimeMs >= startMs && eventTimeMs <= endMs) {
      knownAdverseInWindow++;
      increment(knownAdverseClassifications, event.classification ?? "unknown");
      const family = adverseFamily(event);
      if (family) increment(knownAdverseFamilies, family);
      knownDirectBlockAttempts += directBlockAttempts(event);
    }
    continue;
  }

  const reportedAtMs = Date.parse(event.reported_at);
  if (Number.isFinite(reportedAtMs) && reportedAtMs >= startMs && reportedAtMs <= endMs) {
    unknownAdverseReportsInWindow++;
    increment(unknownAdverseReportClassifications, event.classification ?? "unknown");
    const family = adverseFamily(event);
    if (family) increment(unknownAdverseReportFamilies, family);
  }
}

let acceptanceStatus = "CLEAN_OBSERVED_WINDOW";
if (knownAdverseInWindow > 0) acceptanceStatus = "RECURRENCE_OBSERVED";
else if (unknownAdverseReportsInWindow > 0) acceptanceStatus = "INDETERMINATE_UNKNOWN_EVENT_TIME";
else if (processToolNon2xx > 0 || transportErrors > 0) acceptanceStatus = "TRANSPORT_DEGRADED";
else if (processToolCalls === 0) acceptanceStatus = "NO_PROCESS_TOOL_EVIDENCE";

const activeProcessBins = bins.filter((bin) => bin.process_tool_calls > 0).length;
const processObservationSpanMinutes = processFirstAtMs === null || processLastAtMs === null
  ? 0
  : Number(((processLastAtMs - processFirstAtMs) / 60_000).toFixed(3));

const byTool = {};
for (const tool of [...PROCESS_TOOLS].sort()) {
  const item = processByTool.get(tool) ?? { total: 0, status_200: 0, non_2xx: 0, durations: [] };
  byTool[tool] = {
    total: item.total,
    status_200: item.status_200,
    non_2xx: item.non_2xx,
    duration_ms: durationSummary(item.durations),
  };
}

const report = {
  schema: "mcp-reroute-acceptance.v1",
  window: {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    duration_minutes: Number(((endMs - startMs) / 60_000).toFixed(3)),
    bin_minutes: binMinutes,
  },
  transport: {
    source_file_count: transportSources.length,
    source_files: sourceCoverage,
    archive_segments_skipped_before_window: transportDiscovery.skippedByRotationTime.map((path) => basename(path)),
    selected_event_rows: transportSelected,
    malformed_lines: transportMalformed,
    duplicate_response_finish_rows_skipped: duplicateResponseRowsSkipped,
    duplicate_transport_error_rows_skipped: duplicateTransportErrorRowsSkipped,
    event_counts: statusObject(transportEventCounts),
    transport_error_events: transportErrors,
    response_method_counts: statusObject(methodResponseCounts),
    response_method_status_counts: statusObject(methodStatusCounts),
    non_2xx_response_groups: Object.fromEntries([...non2xxResponseCounts.entries()].sort()),
    process_tool_calls: {
      total: processToolCalls,
      status_200: processToolStatus200,
      non_2xx: processToolNon2xx,
      first_at: processFirstAtMs === null ? null : new Date(processFirstAtMs).toISOString(),
      last_at: processLastAtMs === null ? null : new Date(processLastAtMs).toISOString(),
      observation_span_minutes: processObservationSpanMinutes,
      active_bins: activeProcessBins,
      total_bins: bins.length,
      active_bin_fraction: Number((activeProcessBins / bins.length).toFixed(3)),
      unique_callers: callers.size,
      unique_sessions: sessions.size,
      unique_connections: connections.size,
      by_tool: byTool,
    },
    bins,
  },
  routing_events: {
    total_records: routingRecords,
    malformed_lines: routingMalformed,
    known_event_time_adverse_in_window: knownAdverseInWindow,
    known_event_time_adverse_classifications: statusObject(knownAdverseClassifications),
    known_event_time_adverse_families: statusObject(knownAdverseFamilies),
    known_direct_block_attempts_in_window: knownDirectBlockAttempts,
    unknown_event_time_adverse_reports_received_in_window: unknownAdverseReportsInWindow,
    unknown_event_time_report_classifications: statusObject(unknownAdverseReportClassifications),
    unknown_event_time_adverse_report_families: statusObject(unknownAdverseReportFamilies),
    normalized_rates_per_1000_process_tool_calls: {
      denominator_process_tool_calls: processToolCalls,
      known_event_time_adverse: perThousand(knownAdverseInWindow, processToolCalls),
      known_direct_block_attempts: perThousand(knownDirectBlockAttempts, processToolCalls),
      known_event_time_adverse_families: rateObject(knownAdverseFamilies, processToolCalls),
      unknown_event_time_adverse_reports_received: perThousand(unknownAdverseReportsInWindow, processToolCalls),
      unknown_event_time_adverse_report_families: rateObject(unknownAdverseReportFamilies, processToolCalls),
      semantics: "Descriptive exposure-normalized counts only. Known-time event rates use occurrence-window assignment; unknown-time rates are report-receipt density, not occurrence rates. These rates do not establish statistical significance or causal effect.",
    },
    time_semantics: "event_time_known=true uses event_time for occurrence-window assignment; unknown occurrence times are never inferred from reported_at and are surfaced separately if the report was received inside the window",
  },
  acceptance: {
    status: acceptanceStatus,
    transport_clean: processToolNon2xx === 0 && transportErrors === 0,
    no_known_reroute_recurrence: knownAdverseInWindow === 0,
    process_tool_evidence_present: processToolCalls > 0,
    unknown_event_time_adverse_report_present: unknownAdverseReportsInWindow > 0,
    caveat: "A clean observed window is evidence only. Client-side platform reroutes can occur without an MCP request and absence from the routing-event log is not proof of absence.",
  },
};

console.log(JSON.stringify(report, null, 2));
