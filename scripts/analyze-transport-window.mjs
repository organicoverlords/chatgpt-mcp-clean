import fs from "node:fs";
import readline from "node:readline";

function usage() {
  console.error("usage: node scripts/analyze-transport-window.mjs <transport.jsonl> <start-iso> <end-iso>");
  process.exit(2);
}

if (process.argv.length !== 5) usage();
const [, , logPath, startRaw, endRaw] = process.argv;
const startMs = Date.parse(startRaw);
const endMs = Date.parse(endRaw);
if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) usage();

const eventCounts = new Map();
const statusCounts = new Map();
const toolCounts = new Map();
const durations = [];
const requestedWaitByRequest = new Map();
const waitAttributedResponses = [];
let malformed = 0;
let selected = 0;

function increment(map, key) {
  map.set(String(key), (map.get(String(key)) ?? 0) + 1);
}
const input = fs.createReadStream(logPath, { encoding: "utf8" });
for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    malformed++;
    continue;
  }
  const atMs = Date.parse(event.at);
  if (!Number.isFinite(atMs) || atMs < startMs || atMs > endMs) continue;
  selected++;
  increment(eventCounts, event.event ?? "unknown");
  if (event.event === "process_wait_requested" && event.request_id && Number.isFinite(event.requested_wait_ms)) {
    requestedWaitByRequest.set(event.request_id, event.requested_wait_ms);
  }
  if (event.event === "response_finish") {
    increment(statusCounts, event.status ?? "unknown");
    if (event.mcp_tool) increment(toolCounts, event.mcp_tool);
    if (Number.isFinite(event.duration_ms)) {
      durations.push(event.duration_ms);
      const requestedWaitMs = event.request_id ? requestedWaitByRequest.get(event.request_id) : undefined;
      if (Number.isFinite(requestedWaitMs)) {
        waitAttributedResponses.push({
          duration_ms: event.duration_ms,
          requested_wait_ms: requestedWaitMs,
          mcp_tool: event.mcp_tool ?? "unknown",
        });
      }
    }
  }
}

durations.sort((a, b) => a - b);
function percentile(values, fraction) {
  if (!values.length) return null;
  const index = Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1);
  return values[index];
}

function roundMs(value) {
  return Number(value.toFixed(3));
}

function summarizeWaitAttribution(records) {
  const requestedWaits = records.map((record) => record.requested_wait_ms).sort((a, b) => a - b);
  const deltas = records.map((record) => roundMs(record.duration_ms - record.requested_wait_ms)).sort((a, b) => a - b);
  const nearCeiling = records.filter((record) => record.duration_ms >= record.requested_wait_ms - 250).length;
  const over250 = records.filter((record) => record.duration_ms > record.requested_wait_ms + 250).length;
  const over500 = records.filter((record) => record.duration_ms > record.requested_wait_ms + 500).length;
  const byTool = new Map();
  for (const record of records) {
    const bucket = byTool.get(record.mcp_tool) ?? [];
    bucket.push(record);
    byTool.set(record.mcp_tool, bucket);
  }
  return {
    matched_responses: records.length,
    near_requested_wait_ceiling_250ms: nearCeiling,
    over_requested_wait_250ms: over250,
    over_requested_wait_500ms: over500,
    requested_wait_ms: {
      count: requestedWaits.length,
      p50: percentile(requestedWaits, 0.50),
      p95: percentile(requestedWaits, 0.95),
      p99: percentile(requestedWaits, 0.99),
      max: requestedWaits.length ? requestedWaits.at(-1) : null,
    },
    duration_minus_requested_wait_ms: {
      count: deltas.length,
      min: deltas.length ? deltas[0] : null,
      p50: percentile(deltas, 0.50),
      p95: percentile(deltas, 0.95),
      p99: percentile(deltas, 0.99),
      max: deltas.length ? deltas.at(-1) : null,
    },
    by_tool: Object.fromEntries([...byTool.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tool, toolRecords]) => {
      const excesses = toolRecords.map((record) => roundMs(Math.max(0, record.duration_ms - record.requested_wait_ms)));
      return [tool, {
        matched_responses: toolRecords.length,
        near_requested_wait_ceiling_250ms: toolRecords.filter((record) => record.duration_ms >= record.requested_wait_ms - 250).length,
        over_requested_wait_250ms: toolRecords.filter((record) => record.duration_ms > record.requested_wait_ms + 250).length,
        over_requested_wait_500ms: toolRecords.filter((record) => record.duration_ms > record.requested_wait_ms + 500).length,
        max_positive_excess_ms: excesses.length ? Math.max(...excesses) : null,
      }];
    })),
  };
}

const report = {
  window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
  selected_events: selected,
  malformed_lines: malformed,
  event_counts: Object.fromEntries([...eventCounts].sort()),
  response_status_counts: Object.fromEntries([...statusCounts].sort()),
  response_tool_counts: Object.fromEntries([...toolCounts].sort()),
  response_duration_ms: {
    count: durations.length,
    max: durations.length ? durations.at(-1) : null,
    p50: percentile(durations, 0.50),
    p95: percentile(durations, 0.95),
    p99: percentile(durations, 0.99),
  },
  response_wait_attribution: summarizeWaitAttribution(waitAttributedResponses),
};

console.log(JSON.stringify(report, null, 2));
