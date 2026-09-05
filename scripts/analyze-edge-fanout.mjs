import fs from "node:fs";
import readline from "node:readline";

function usage() {
  console.error("usage: node scripts/analyze-edge-fanout.mjs <caddy-access.jsonl|-> [--since <iso>] [--until <iso>]");
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length) usage();
const logPath = args.shift();
let startMs = Number.NEGATIVE_INFINITY;
let endMs = Number.POSITIVE_INFINITY;
while (args.length) {
  const flag = args.shift();
  const raw = args.shift();
  if (!raw || (flag !== "--since" && flag !== "--until")) usage();
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) usage();
  if (flag === "--since") startMs = parsed;
  else endMs = parsed;
}
if (endMs < startMs) usage();

const statusCounts = new Map();
const socketCounts = new Map();
const remoteIps = new Set();
const firstSocketTlsResumed = new Map();
const sessions = new Map();
const durations = [];
let malformedLines = 0;
let posts = 0;
let attributedPosts = 0;
let unattributedPosts = 0;
let http11Posts = 0;
let keepAlivePosts = 0;
let tlsResumedRequests = 0;
let responseBytes = 0;
let sourceTimestampedRows = 0;
let sourceStartMs = Number.POSITIVE_INFINITY;
let sourceEndMs = Number.NEGATIVE_INFINITY;
let selectedStartMs = Number.POSITIVE_INFINITY;
let selectedEndMs = Number.NEGATIVE_INFINITY;

function increment(map, key) {
  const normalized = String(key);
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

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

function socketKey(request) {
  if (!request?.remote_ip || !request?.remote_port) return undefined;
  return `${request.remote_ip}:${request.remote_port}`;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const index = Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1);
  return values[index];
}

function ratio(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

const input = logPath === "-" ? process.stdin : fs.createReadStream(logPath, { encoding: "utf8" });
if (logPath === "-") process.stdin.setEncoding("utf8");
for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    malformedLines++;
    continue;
  }
  const eventMs = Number(event.ts) * 1000;
  if (Number.isFinite(eventMs)) {
    sourceTimestampedRows++;
    sourceStartMs = Math.min(sourceStartMs, eventMs);
    sourceEndMs = Math.max(sourceEndMs, eventMs);
  }
  const request = event.request ?? {};
  if (request.method !== "POST" || request.uri !== "/mcp") continue;
  if (!Number.isFinite(eventMs) || eventMs < startMs || eventMs > endMs) continue;

  posts++;
  selectedStartMs = Math.min(selectedStartMs, eventMs);
  selectedEndMs = Math.max(selectedEndMs, eventMs);
  increment(statusCounts, event.status ?? "unknown");
  if (request.proto === "HTTP/1.1") http11Posts++;
  if ((header(request.headers, "Connection") ?? "").toLowerCase().includes("keep-alive")) keepAlivePosts++;
  if (request.tls?.resumed === true) tlsResumedRequests++;
  if (Number.isFinite(event.duration)) durations.push(event.duration);
  if (Number.isFinite(event.size)) responseBytes += event.size;

  const socket = socketKey(request);
  if (socket) {
    increment(socketCounts, socket);
    if (!firstSocketTlsResumed.has(socket)) firstSocketTlsResumed.set(socket, request.tls?.resumed === true);
  }
  if (request.remote_ip) remoteIps.add(request.remote_ip);

  const session = header(request.headers, "X-Openai-Session");
  if (!session) {
    unattributedPosts++;
    continue;
  }
  attributedPosts++;
  let entries = sessions.get(session);
  if (!entries) {
    entries = [];
    sessions.set(session, entries);
  }
  entries.push({ eventMs, socket, remoteIp: request.remote_ip });
}

durations.sort((a, b) => a - b);
let consecutivePairs = 0;
let socketChanges = 0;
let remoteIpChanges = 0;
let busiestSession = null;
for (const entries of sessions.values()) {
  entries.sort((a, b) => a.eventMs - b.eventMs);
  const uniqueSockets = new Set(entries.map((entry) => entry.socket).filter(Boolean));
  const uniqueRemoteIps = new Set(entries.map((entry) => entry.remoteIp).filter(Boolean));
  let sessionPairs = 0;
  let sessionSocketChanges = 0;
  let sessionRemoteIpChanges = 0;
  for (let index = 1; index < entries.length; index++) {
    const previous = entries[index - 1];
    const current = entries[index];
    sessionPairs++;
    if (previous.socket && current.socket && previous.socket !== current.socket) sessionSocketChanges++;
    if (previous.remoteIp && current.remoteIp && previous.remoteIp !== current.remoteIp) sessionRemoteIpChanges++;
  }
  consecutivePairs += sessionPairs;
  socketChanges += sessionSocketChanges;
  remoteIpChanges += sessionRemoteIpChanges;
  const candidate = {
    requests: entries.length,
    unique_sockets: uniqueSockets.size,
    unique_remote_ips: uniqueRemoteIps.size,
    consecutive_pairs: sessionPairs,
    socket_changes: sessionSocketChanges,
    remote_ip_changes: sessionRemoteIpChanges,
  };
  if (!busiestSession || candidate.requests > busiestSession.requests) busiestSession = candidate;
}

const socketValues = [...socketCounts.values()];
const report = {
  source_window: {
    timestamped_rows: sourceTimestampedRows,
    start: sourceTimestampedRows ? new Date(sourceStartMs).toISOString() : null,
    end: sourceTimestampedRows ? new Date(sourceEndMs).toISOString() : null,
    requested_since: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
    requested_until: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
    requested_since_covered: Number.isFinite(startMs) ? (sourceTimestampedRows > 0 && sourceStartMs <= startMs) : null,
    requested_until_covered: Number.isFinite(endMs) ? (sourceTimestampedRows > 0 && sourceEndMs >= endMs) : null,
  },
  window: {
    start: posts ? new Date(selectedStartMs).toISOString() : null,
    end: posts ? new Date(selectedEndMs).toISOString() : null,
  },
  mcp_posts: posts,
  malformed_lines: malformedLines,
  status_counts: Object.fromEntries([...statusCounts].sort(([a], [b]) => a.localeCompare(b))),
  request_contract: {
    http_1_1_posts: http11Posts,
    keep_alive_posts: keepAlivePosts,
  },
  public_connections: {
    unique_sockets: socketCounts.size,
    requests_per_socket: ratio(posts, socketCounts.size),
    reused_sockets: socketValues.filter((count) => count > 1).length,
    max_requests_per_socket: socketValues.length ? Math.max(...socketValues) : null,
    unique_remote_ips: remoteIps.size,
    tls_resumed_requests: tlsResumedRequests,
    tls_resumed_sockets: [...firstSocketTlsResumed.values()].filter(Boolean).length,
  },
  openai_sessions: {
    unique_sessions: sessions.size,
    attributed_posts: attributedPosts,
    unattributed_posts: unattributedPosts,
    consecutive_pairs: consecutivePairs,
    socket_changes: socketChanges,
    socket_change_rate: ratio(socketChanges, consecutivePairs),
    remote_ip_changes: remoteIpChanges,
    remote_ip_change_rate: ratio(remoteIpChanges, consecutivePairs),
    busiest_session: busiestSession,
  },
  response: {
    bytes: responseBytes,
    duration_seconds: {
      count: durations.length,
      p50: percentile(durations, 0.50),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      max: durations.length ? durations.at(-1) : null,
    },
  },
  privacy: {
    raw_identifiers_emitted: false,
  },
};

console.log(JSON.stringify(report, null, 2));
