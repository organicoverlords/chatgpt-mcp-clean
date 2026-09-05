import fs from "node:fs";
import readline from "node:readline";

function usage() {
  console.error("usage: node scripts/analyze-edge-backend-correlation.mjs <caddy-access.jsonl> <transport.jsonl> <start-iso> <end-iso>");
  process.exit(2);
}

if (process.argv.length !== 6) usage();
const [, , edgePath, transportPath, startRaw, endRaw] = process.argv;
const startMs = Date.parse(startRaw);
const endMs = Date.parse(endRaw);
if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) usage();
const BACKEND_WINDOW_MARGIN_MS = 60_000;

function header(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value[0];
    if (typeof value === "string") return value;
    return undefined;
  }
  return undefined;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const index = Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1);
  return values[index];
}

function roundMs(value) {
  return Number(value.toFixed(3));
}

const edgeRequests = [];
let edgeMalformedLines = 0;
let edgePostsWithoutRequestId = 0;
const edgeInput = fs.createReadStream(edgePath, { encoding: "utf8" });
for await (const line of readline.createInterface({ input: edgeInput, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    edgeMalformedLines++;
    continue;
  }
  const request = event.request ?? {};
  if (request.method !== "POST" || request.uri !== "/mcp") continue;
  const eventMs = Number(event.ts) * 1000;
  if (!Number.isFinite(eventMs) || eventMs < startMs || eventMs > endMs) continue;
  const requestId = header(event.resp_headers, "X-Shell-Mcp-Request-Id");
  if (!requestId) edgePostsWithoutRequestId++;
  edgeRequests.push({
    request_id: requestId,
    duration_ms: Number.isFinite(event.duration) ? event.duration * 1000 : undefined,
    status: event.status,
  });
}

const backendResponses = new Map();
let backendMalformedLines = 0;
let backendResponseCandidates = 0;
const transportInput = fs.createReadStream(transportPath, { encoding: "utf8" });
for await (const line of readline.createInterface({ input: transportInput, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    backendMalformedLines++;
    continue;
  }
  if (event.event !== "response_finish" || !event.request_id) continue;
  const eventMs = Date.parse(event.at);
  if (!Number.isFinite(eventMs) || eventMs < startMs - BACKEND_WINDOW_MARGIN_MS || eventMs > endMs + BACKEND_WINDOW_MARGIN_MS) continue;
  backendResponseCandidates++;
  backendResponses.set(event.request_id, {
    duration_ms: event.duration_ms,
    status: event.status,
  });
}

const deltas = [];
let matchedRequests = 0;
let unmatchedEdgeRequests = 0;
let statusMismatches = 0;
for (const edge of edgeRequests) {
  if (!edge.request_id) continue;
  const backend = backendResponses.get(edge.request_id);
  if (!backend) {
    unmatchedEdgeRequests++;
    continue;
  }
  matchedRequests++;
  if (String(edge.status) !== String(backend.status)) statusMismatches++;
  if (Number.isFinite(edge.duration_ms) && Number.isFinite(backend.duration_ms)) {
    deltas.push(roundMs(edge.duration_ms - backend.duration_ms));
  }
}

deltas.sort((a, b) => a - b);
const report = {
  window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
  edge_mcp_posts: edgeRequests.length,
  edge_posts_with_request_id: edgeRequests.length - edgePostsWithoutRequestId,
  edge_posts_without_request_id: edgePostsWithoutRequestId,
  backend_response_candidates: backendResponseCandidates,
  matched_requests: matchedRequests,
  unmatched_edge_requests: unmatchedEdgeRequests,
  status_mismatches: statusMismatches,
  malformed_lines: {
    edge: edgeMalformedLines,
    backend: backendMalformedLines,
  },
  edge_minus_backend_duration_ms: {
    count: deltas.length,
    min: deltas.length ? deltas[0] : null,
    p50: percentile(deltas, 0.50),
    p95: percentile(deltas, 0.95),
    p99: percentile(deltas, 0.99),
    max: deltas.length ? deltas.at(-1) : null,
  },
  proxy_overhead_thresholds: {
    over_50ms: deltas.filter((value) => value > 50).length,
    over_100ms: deltas.filter((value) => value > 100).length,
    over_250ms: deltas.filter((value) => value > 250).length,
    below_minus_10ms: deltas.filter((value) => value < -10).length,
  },
  privacy: {
    raw_request_ids_emitted: false,
  },
};

console.log(JSON.stringify(report, null, 2));
