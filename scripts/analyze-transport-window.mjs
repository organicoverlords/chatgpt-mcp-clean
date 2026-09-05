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
const requestStartByRequest = new Map();
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
  if (event.event === "request_start" && event.request_id) {
    requestStartByRequest.set(event.request_id, atMs);
  }
  if (event.event === "process_wait_requested" && event.request_id && Number.isFinite(event.requested_wait_ms)) {
    requestedWaitByRequest.set(event.request_id, { requested_wait_ms: event.requested_wait_ms, wait_requested_at_ms: atMs });
  }
  if (event.event === "response_finish") {
    increment(statusCounts, event.status ?? "unknown");
    if (event.mcp_tool) increment(toolCounts, event.mcp_tool);
    if (Number.isFinite(event.duration_ms)) {
      durations.push(event.duration_ms);
      const requestedWait = event.request_id ? requestedWaitByRequest.get(event.request_id) : undefined;
      if (requestedWait) {
        const requestStartAtMs = requestStartByRequest.get(event.request_id);
        waitAttributedResponses.push({
          response_duration_ms: event.duration_ms,
          requested_wait_ms: requestedWait.requested_wait_ms,
          wait_requested_at_ms: requestedWait.wait_requested_at_ms,
          response_finished_at_ms: atMs,
          request_started_at_ms: Number.isFinite(requestStartAtMs) ? requestStartAtMs : null,
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

function distribution(values) {
  const sorted = values.map(roundMs).sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted.length ? sorted[0] : null,
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? sorted.at(-1) : null,
  };
}

function timing(record) {
  const postWaitElapsedMs = record.response_finished_at_ms - record.wait_requested_at_ms;
  return {
    pre_wait_setup_ms: Number.isFinite(record.request_started_at_ms) ? record.wait_requested_at_ms - record.request_started_at_ms : null,
    post_wait_elapsed_ms: postWaitElapsedMs,
    post_wait_excess_ms: postWaitElapsedMs - record.requested_wait_ms,
  };
}

function summarizeWaitAttribution(records) {
  const requestedWaits = records.map((record) => record.requested_wait_ms).sort((a, b) => a - b);
  const timed = records.map((record) => ({ ...record, ...timing(record) }));
  const preWaitSetup = timed.map((record) => record.pre_wait_setup_ms).filter(Number.isFinite);
  const postWaitElapsed = timed.map((record) => record.post_wait_elapsed_ms);
  const postWaitExcess = timed.map((record) => record.post_wait_excess_ms);
  const nearCeiling = timed.filter((record) => record.post_wait_elapsed_ms >= record.requested_wait_ms - 250).length;
  const over250 = timed.filter((record) => record.post_wait_excess_ms > 250).length;
  const over500 = timed.filter((record) => record.post_wait_excess_ms > 500).length;
  const byTool = new Map();
  for (const record of timed) {
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
    pre_wait_setup_ms: {
      ...distribution(preWaitSetup),
      over_250ms: preWaitSetup.filter((value) => value > 250).length,
      over_500ms: preWaitSetup.filter((value) => value > 500).length,
    },
    post_wait_elapsed_ms: distribution(postWaitElapsed),
    post_wait_excess_ms: distribution(postWaitExcess),
    by_tool: Object.fromEntries([...byTool.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tool, toolRecords]) => {
      const toolPreWaitSetup = toolRecords.map((record) => record.pre_wait_setup_ms).filter(Number.isFinite);
      const positiveExcesses = toolRecords.map((record) => Math.max(0, record.post_wait_excess_ms));
      return [tool, {
        matched_responses: toolRecords.length,
        pre_wait_setup_over_250ms: toolPreWaitSetup.filter((value) => value > 250).length,
        pre_wait_setup_over_500ms: toolPreWaitSetup.filter((value) => value > 500).length,
        max_pre_wait_setup_ms: toolPreWaitSetup.length ? roundMs(Math.max(...toolPreWaitSetup)) : null,
        near_requested_wait_ceiling_250ms: toolRecords.filter((record) => record.post_wait_elapsed_ms >= record.requested_wait_ms - 250).length,
        over_requested_wait_250ms: toolRecords.filter((record) => record.post_wait_excess_ms > 250).length,
        over_requested_wait_500ms: toolRecords.filter((record) => record.post_wait_excess_ms > 500).length,
        max_positive_post_wait_excess_ms: positiveExcesses.length ? roundMs(Math.max(...positiveExcesses)) : null,
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
