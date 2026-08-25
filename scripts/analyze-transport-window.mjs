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
  if (event.event === "response_finish") {
    increment(statusCounts, event.status ?? "unknown");
    if (event.mcp_tool) increment(toolCounts, event.mcp_tool);
    if (Number.isFinite(event.duration_ms)) durations.push(event.duration_ms);
  }
}

durations.sort((a, b) => a - b);
function percentile(values, fraction) {
  if (!values.length) return null;
  const index = Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1);
  return values[index];
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
};

console.log(JSON.stringify(report, null, 2));
