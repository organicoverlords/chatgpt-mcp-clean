import fs from "node:fs";
import readline from "node:readline";

if (process.argv.length < 4 || process.argv.length > 5) {
  console.error("usage: node scripts/analyze-transport-generations.mjs <transport.jsonl> <windows.json> [max-bytes]");
  process.exit(2);
}
const [, , logPath, windowsPath, maxBytesRaw] = process.argv;
const windows = JSON.parse(fs.readFileSync(windowsPath, "utf8"));
const maxBytes = maxBytesRaw === undefined ? undefined : Number(maxBytesRaw);
if (!Array.isArray(windows) || !windows.length || (maxBytesRaw && !Number.isSafeInteger(maxBytes))) process.exit(2);
const state = new Map(windows.map((w) => [w.id, {
  responses: 0, callers: new Set(), status: new Map(), tools: new Map(),
  toolDurations: new Map(), responseBytes: [],
}]));
const increment = (map, key) => map.set(String(key), (map.get(String(key)) ?? 0) + 1);
const stream = fs.createReadStream(logPath, { encoding: "utf8", ...(maxBytes ? { end: maxBytes - 1 } : {}) });
for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  const at = event.at ?? "";
  const window = windows.find((w) => w.start <= at && at < w.end);
  if (!window) continue;
  const bucket = state.get(window.id);
  if (event.caller_id) bucket.callers.add(event.caller_id);
  if (event.event !== "response_finish") continue;
  bucket.responses++;
  increment(bucket.status, event.status ?? "unknown");
  if (event.mcp_tool) increment(bucket.tools, event.mcp_tool);  if (Number.isFinite(event.duration_ms)) {
    const key = event.mcp_tool ?? "_http";
    const durations = bucket.toolDurations.get(key) ?? [];
    durations.push(event.duration_ms);
    bucket.toolDurations.set(key, durations);
  }
  if (Number.isFinite(event.response_bytes)) bucket.responseBytes.push(event.response_bytes);
}
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}
const report = windows.map((window) => {
  const bucket = state.get(window.id);
  const reads = bucket.tools.get("read_output") ?? 0;
  const starts = bucket.tools.get("start_process") ?? 0;
  const readDurations = bucket.toolDurations.get("read_output") ?? [];
  return {
    ...window,
    responses: bucket.responses,
    caller_count: bucket.callers.size,
    response_status_counts: Object.fromEntries([...bucket.status].sort()),
    tool_counts: Object.fromEntries([...bucket.tools].sort()),
    read_output_per_start_process: starts ? Number((reads / starts).toFixed(2)) : null,
    read_output_duration_ms: {
      count: readDurations.length,
      p50: percentile(readDurations, 0.50),
      p95: percentile(readDurations, 0.95),      p99: percentile(readDurations, 0.99),
      max: readDurations.length ? Math.max(...readDurations) : null,
      ge_9000ms: readDurations.filter((value) => value >= 9000).length,
    },
    response_bytes: {
      coverage: bucket.responseBytes.length,
      max: bucket.responseBytes.length ? Math.max(...bucket.responseBytes) : null,
    },
  };
});
console.log(JSON.stringify(report, null, 2));