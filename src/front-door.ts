#!/usr/bin/env node
import "dotenv/config";
import { Agent, createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createWriteStream, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type BackendTarget = { version: 1; port: number; generation: string };
type ProcessRoute = { port: number; generation: string; created_at: string };
type ProcessRouteFile = { version: 1; routes: Record<string, ProcessRoute> };
type McpCall = { tool?: string; processId?: string };
type StaticRouteFile = { version: 1; routes: Record<string, number | number[]> };
type StaticRoute = { slug: string; ports: number[] };
type StaticAttempt = {
  port: number;
  statusCode: number;
  statusMessage?: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

const HOST = process.env.FRONT_DOOR_HOST || "127.0.0.1";
const PORT = Number(process.env.FRONT_DOOR_PORT || 3003);
const BACKEND_CONFIG_PATH = resolve(process.env.MCP_BACKEND_CONFIG_PATH || ".state/front-door/active-backend.json");
const PROCESS_ROUTES_PATH = resolve(process.env.MCP_PROCESS_ROUTE_PATH || ".state/front-door/process-routes.json");
const REQUEST_LOG_PATH = resolve(process.env.FRONT_DOOR_REQUEST_LOG_PATH || ".state/front-door/request.jsonl");
const STATIC_ROUTE_PATH = resolve(process.env.FRONT_DOOR_STATIC_ROUTE_PATH || ".state/front-door/static-routes.json");
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const PROCESS_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOP_BY_HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const backendAgent = new Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32 });

if (HOST !== "127.0.0.1" || !Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  throw new Error("The MCP front door must bind a non-privileged port on 127.0.0.1");
}

mkdirSync(dirname(REQUEST_LOG_PATH), { recursive: true });
const requestLogStream = createWriteStream(REQUEST_LOG_PATH, { flags: "a", encoding: "utf8" });
let requestSequence = 0;
function frontDoorLog(event: string, fields: Record<string, unknown> = {}): void {
  requestLogStream.write(`${JSON.stringify({ at: new Date().toISOString(), event, front_pid: process.pid, ...fields })}\n`);
}

function validBackend(value: unknown): value is BackendTarget {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BackendTarget>;
  return candidate.version === 1 && Number.isInteger(candidate.port) && candidate.port! >= 1024 && candidate.port! <= 65535 && candidate.port !== PORT && typeof candidate.generation === "string" && candidate.generation.length > 0;
}

let lastStaticRoutes: StaticRoute[] = [];
function staticRoutes(): StaticRoute[] {
  try {
    const parsed = JSON.parse(readFileSync(STATIC_ROUTE_PATH, "utf8").replace(/^\uFEFF/, "")) as Partial<StaticRouteFile>;
    if (parsed.version !== 1 || !parsed.routes || typeof parsed.routes !== "object") throw new Error("invalid static route config");
    const routes = Object.entries(parsed.routes).map(([slug, configuredPorts]) => {
      const ports = [...new Set(Array.isArray(configuredPorts) ? configuredPorts : [configuredPorts])];
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(slug) || ports.length === 0 || ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535 || port === PORT)) throw new Error("invalid static route");
      return { slug, ports };
    });
    lastStaticRoutes = routes;
  } catch (error) {
    if (lastStaticRoutes.length === 0) {
      try { readFileSync(STATIC_ROUTE_PATH, "utf8"); } catch { return []; }
      throw error;
    }
  }
  return lastStaticRoutes;
}

function staticRouteForUrl(rawUrl: string, requestPath: string): { route: StaticRoute; upstreamPath: string } | undefined {
  const queryIndex = rawUrl.indexOf("?");
  const query = queryIndex >= 0 ? rawUrl.slice(queryIndex) : "";
  for (const route of staticRoutes()) {
    const prefix = `/${route.slug}`;
    if (requestPath === prefix || requestPath.startsWith(`${prefix}/`)) {
      const stripped = requestPath.slice(prefix.length) || "/";
      return { route, upstreamPath: `${stripped}${query}` };
    }
    for (const base of ["/.well-known/oauth-authorization-server/", "/.well-known/oauth-protected-resource/", "/.well-known/openid-configuration/"]) {
      const marker = `${base}${route.slug}`;
      if (requestPath === marker || requestPath.startsWith(`${marker}/`)) return { route, upstreamPath: rawUrl };
    }
  }
  return undefined;
}

let lastBackend: BackendTarget | undefined;
function backendTarget(): BackendTarget {
  try {
    const parsed = JSON.parse(readFileSync(BACKEND_CONFIG_PATH, "utf8").replace(/^\uFEFF/, "")) as unknown;
    if (!validBackend(parsed)) throw new Error("invalid backend config");
    lastBackend = parsed;
  } catch (error) {
    if (!lastBackend) throw error;
  }
  return lastBackend!;
}

function loadProcessRoutes(): Map<string, ProcessRoute> {
  try {
    const parsed = JSON.parse(readFileSync(PROCESS_ROUTES_PATH, "utf8").replace(/^\uFEFF/, "")) as Partial<ProcessRouteFile>;
    if (parsed.version !== 1 || !parsed.routes || typeof parsed.routes !== "object") return new Map();
    return new Map(Object.entries(parsed.routes).filter(([id, route]) => PROCESS_ID_PATTERN.test(id) && validRoute(route)));
  } catch {
    return new Map();
  }
}

function validRoute(value: unknown): value is ProcessRoute {
  if (!value || typeof value !== "object") return false;
  const route = value as Partial<ProcessRoute>;
  return Number.isInteger(route.port) && route.port! >= 1024 && route.port! <= 65535 && typeof route.generation === "string" && typeof route.created_at === "string";
}

const processRoutes = loadProcessRoutes();
function persistProcessRoutes(): void {
  mkdirSync(dirname(PROCESS_ROUTES_PATH), { recursive: true });
  const temporary = `${PROCESS_ROUTES_PATH}.${process.pid}.tmp`;
  const routes = Object.fromEntries([...processRoutes.entries()].sort(([left], [right]) => left.localeCompare(right)));
  writeFileSync(temporary, `${JSON.stringify({ version: 1, routes }, null, 2)}\n`, "utf8");
  renameSync(temporary, PROCESS_ROUTES_PATH);
}

function parseMcpCall(body: Buffer): McpCall {
  try {
    const request = JSON.parse(body.toString("utf8")) as { method?: unknown; params?: { name?: unknown; arguments?: Record<string, unknown> } };
    if (request.method !== "tools/call" || typeof request.params?.name !== "string") return {};
    const tool = request.params.name;
    const args = request.params.arguments || {};
    let processId = typeof args.process_id === "string" ? args.process_id : undefined;
    if (!processId && typeof args.scope === "string" && args.scope.startsWith("process:")) processId = args.scope.slice("process:".length);
    return { tool, processId };
  } catch {
    return {};
  }
}

function rpcBody(body: Buffer, contentType: string): unknown {
  const text = body.toString("utf8");
  try {
    if (contentType.includes("text/event-stream")) {
      const matches = [...text.matchAll(/^data:\s*(.+)$/gm)];
      return matches.length ? JSON.parse(matches.at(-1)![1]) : undefined;
    }
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toolPayload(body: Buffer, contentType: string): Record<string, unknown> | undefined {
  const rpc = rpcBody(body, contentType) as { result?: { content?: Array<{ type?: string; text?: string }> } } | undefined;
  const text = rpc?.result?.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function updateProcessRoute(call: McpCall, target: BackendTarget, responseBody: Buffer, contentType: string): void {
  const result = toolPayload(responseBody, contentType);
  if (!result) return;
  if (call.tool === "start_process" && typeof result.process_id === "string" && PROCESS_ID_PATTERN.test(result.process_id)) {
    processRoutes.set(result.process_id, { port: target.port, generation: target.generation, created_at: new Date().toISOString() });
    persistProcessRoutes();
    return;
  }
  if (!call.processId || !processRoutes.has(call.processId)) return;
  if ((call.tool === "read_output" && result.running === false) || (call.tool === "kill_process" && (result.killed === true || result.already_exited === true))) {
    processRoutes.delete(call.processId);
    persistProcessRoutes();
  }
}

function outgoingHeaders(headers: IncomingHttpHeaders, target: { port: number }): IncomingHttpHeaders {
  const next: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) next[name] = value;
  }
  // Preserve the original Host and forwarded headers. The backend explicitly
  // allowlists the front-door host, and worker-visible request semantics stay exact.
  if (!next.host) next.host = `127.0.0.1:${target.port}`;
  return next;
}

function copyResponseHeaders(headers: IncomingHttpHeaders, response: ServerResponse): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) response.setHeader(name, value);
  }
}

let activeRequests = 0;
let totalRequests = 0;

async function targetGenerationMatches(target: BackendTarget): Promise<boolean> {
  return new Promise((resolveMatch) => {
    const probe = httpRequest({ host: "127.0.0.1", port: target.port, path: "/health", method: "GET", agent: false }, (probeResponse) => {
      const chunks: Buffer[] = [];
      probeResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
      probeResponse.on("end", () => {
        try {
          const health = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status?: unknown; name?: unknown; pid?: unknown; backend_generation?: unknown };
          if (health.status !== "ok" || health.name !== "shell-mcp") return resolveMatch(false);
          if (target.generation.startsWith("legacy-")) return resolveMatch(String(health.pid) === target.generation.slice("legacy-".length));
          resolveMatch(health.backend_generation === target.generation);
        } catch { resolveMatch(false); }
      });
    });
    probe.setTimeout(1_000, () => probe.destroy());
    probe.on("error", () => resolveMatch(false));
    probe.end();
  });
}

async function proxyRequest(request: IncomingMessage, response: ServerResponse, body: Buffer, call: McpCall, requestId?: string): Promise<void> {
  const active = backendTarget();
  const pinned = call.processId ? processRoutes.get(call.processId) : undefined;
  const target = pinned ? { version: 1 as const, port: pinned.port, generation: pinned.generation } : active;
  if (requestId) frontDoorLog("front_backend_select", { request_id: requestId, tool: call.tool || null, process_id: call.processId || null, backend_port: target.port, backend_generation: target.generation, pinned: Boolean(pinned) });
  if (!await targetGenerationMatches(target)) {
    if (requestId) frontDoorLog("front_backend_unavailable", { request_id: requestId, backend_port: target.port, backend_generation: target.generation });
    if (!response.destroyed && !response.headersSent) {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.setHeader("retry-after", "1");
      response.end(JSON.stringify({ error: "Service unavailable" }));
    }
    return;
  }
  activeRequests += 1;
  totalRequests += 1;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    activeRequests -= 1;
  };
  if (requestId) frontDoorLog("front_backend_dispatch", { request_id: requestId, backend_port: target.port, backend_generation: target.generation });
  const upstream = httpRequest({
    host: "127.0.0.1",
    port: target.port,
    method: request.method,
    path: request.url,
    headers: outgoingHeaders(request.headers, target),
    agent: backendAgent,
  }, (backendResponse) => {
    if (requestId) frontDoorLog("front_backend_response", { request_id: requestId, backend_port: target.port, status: backendResponse.statusCode || null });
    if (!response.destroyed && !response.headersSent) {
      response.statusCode = backendResponse.statusCode || 502;
      response.statusMessage = backendResponse.statusMessage || response.statusMessage;
      copyResponseHeaders(backendResponse.headers, response);
    }
    const captured: Buffer[] = [];
    let capturedBytes = 0;
    backendResponse.on("data", (chunk: Buffer) => {
      if (capturedBytes < MAX_CAPTURE_BYTES) {
        const remaining = MAX_CAPTURE_BYTES - capturedBytes;
        captured.push(chunk.subarray(0, remaining));
        capturedBytes += Math.min(chunk.length, remaining);
      }
      if (!response.destroyed) response.write(chunk);
    });
    backendResponse.on("end", () => {
      const responseBody = Buffer.concat(captured);
      updateProcessRoute(call, target, responseBody, String(backendResponse.headers["content-type"] || ""));
      if (!response.destroyed) response.end();
      finish();
    });
    backendResponse.on("error", () => {
      if (!response.destroyed) response.destroy();
      finish();
    });
  });
  upstream.setTimeout(35_000, () => upstream.destroy(new Error("backend request timeout")));
  upstream.on("error", (error) => {
    if (requestId) frontDoorLog("front_backend_error", { request_id: requestId, backend_port: target.port, error: error.message });
    if (!response.destroyed && !response.headersSent) {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.setHeader("retry-after", "1");
      response.end(JSON.stringify({ error: "Service unavailable" }));
    } else if (!response.destroyed) {
      response.destroy();
    }
    finish();
  });
  upstream.end(body);
}

function staticAttempt(request: IncomingMessage, body: Buffer, match: { route: StaticRoute; upstreamPath: string }, port: number): Promise<StaticAttempt> {
  return new Promise((resolveAttempt, rejectAttempt) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectAttempt(error);
    };
    const upstream = httpRequest({
      host: "127.0.0.1",
      port,
      method: request.method,
      path: match.upstreamPath,
      headers: outgoingHeaders(request.headers, { port }),
      agent: backendAgent,
    }, (backendResponse) => {
      const chunks: Buffer[] = [];
      let capturedBytes = 0;
      backendResponse.on("data", (chunk: Buffer) => {
        capturedBytes += chunk.length;
        if (capturedBytes > MAX_CAPTURE_BYTES) {
          backendResponse.destroy(new Error("static backend response exceeded capture limit"));
          return;
        }
        chunks.push(chunk);
      });
      backendResponse.on("end", () => {
        if (settled) return;
        settled = true;
        resolveAttempt({
          port,
          statusCode: backendResponse.statusCode || 502,
          statusMessage: backendResponse.statusMessage,
          headers: backendResponse.headers,
          body: Buffer.concat(chunks),
        });
      });
      backendResponse.on("error", fail);
    });
    // A normal start_process request may intentionally wait for output before
    // returning. Match the dynamic proxy's bound so a successful command is
    // not reported as 503 merely because wait_ms exceeds the health-probe
    // timeout. Ambiguous timeouts are still never retried.
    upstream.setTimeout(35_000, () => upstream.destroy(new Error("static backend request timeout")));
    upstream.on("error", fail);
    upstream.end(body);
  });
}

function staticBackendHealthy(port: number): Promise<boolean> {
  return new Promise((resolveHealthy) => {
    let settled = false;
    const finish = (healthy: boolean) => {
      if (settled) return;
      settled = true;
      resolveHealthy(healthy);
    };
    const probe = httpRequest({ host: "127.0.0.1", port, path: "/health", method: "GET", agent: backendAgent }, (probeResponse) => {
      const chunks: Buffer[] = [];
      probeResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
      probeResponse.on("end", () => {
        try {
          const health = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status?: unknown; name?: unknown; port?: unknown };
          finish(probeResponse.statusCode === 200 && health.status === "ok" && health.name === "shell-mcp" && health.port === port);
        } catch { finish(false); }
      });
    });
    probe.setTimeout(1_000, () => probe.destroy(new Error("static backend health timeout")));
    probe.on("error", () => finish(false));
    probe.end();
  });
}

function retryableStaticStatus(statusCode: number): boolean {
  // These responses prove the replacement rejected the request before a tool
  // ran. Retrying an ambiguous timeout or 5xx could execute start_process twice.
  return statusCode === 401 || statusCode === 403 || statusCode === 404;
}

async function proxyStaticRequest(request: IncomingMessage, response: ServerResponse, body: Buffer, match: { route: StaticRoute; upstreamPath: string }, requestId?: string): Promise<void> {
  activeRequests += 1;
  totalRequests += 1;
  let lastAttempt: StaticAttempt | undefined;
  try {
    for (let index = 0; index < match.route.ports.length; index += 1) {
      const port = match.route.ports[index];
      if (!await staticBackendHealthy(port)) {
        if (requestId) frontDoorLog("front_static_unhealthy", { request_id: requestId, route: match.route.slug, backend_port: port, fallback_index: index });
        if (index === match.route.ports.length - 1) throw new Error("all static backends are unhealthy");
        if (requestId) frontDoorLog("front_static_retry", { request_id: requestId, route: match.route.slug, failed_backend_port: port, status: null, next_backend_port: match.route.ports[index + 1] });
        continue;
      }
      if (requestId) frontDoorLog("front_static_dispatch", { request_id: requestId, route: match.route.slug, backend_port: port, upstream_path: match.upstreamPath.split("?", 1)[0], fallback_index: index });
      try {
        const attempt = await staticAttempt(request, body, match, port);
        lastAttempt = attempt;
        if (requestId) frontDoorLog("front_static_response", { request_id: requestId, route: match.route.slug, backend_port: port, status: attempt.statusCode, fallback_index: index });
        if (!retryableStaticStatus(attempt.statusCode) || index === match.route.ports.length - 1) break;
        if (requestId) frontDoorLog("front_static_retry", { request_id: requestId, route: match.route.slug, failed_backend_port: port, status: attempt.statusCode, next_backend_port: match.route.ports[index + 1] });
      } catch (error) {
        if (requestId) frontDoorLog("front_static_error", { request_id: requestId, route: match.route.slug, backend_port: port, error: error instanceof Error ? error.message : String(error), fallback_index: index });
        throw error;
      }
    }
    if (!lastAttempt) throw new Error("no static backend returned a response");
    if (!response.destroyed && !response.headersSent) {
      response.statusCode = lastAttempt.statusCode;
      response.statusMessage = lastAttempt.statusMessage || response.statusMessage;
      copyResponseHeaders(lastAttempt.headers, response);
      response.end(lastAttempt.body);
    }
  } catch {
    if (!response.destroyed && !response.headersSent) {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.setHeader("retry-after", "1");
      response.end(JSON.stringify({ error: "Service unavailable" }));
    } else if (!response.destroyed) response.destroy();
  } finally {
    activeRequests -= 1;
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  const rawUrl = request.url || "";
  const requestPath = rawUrl.split("?", 1)[0] || "";
  const staticMatch = staticRouteForUrl(rawUrl, requestPath);
  const isMcpRequest = requestPath === "/mcp" || staticMatch?.upstreamPath.split("?", 1)[0] === "/mcp";
  const requestId = isMcpRequest ? `${process.pid}-${Date.now()}-${++requestSequence}` : undefined;
  const requestStartedAt = Date.now();
  let requestFinished = false;
  if (requestId) {
    frontDoorLog("front_request_start", { request_id: requestId, method: request.method || null, path: requestPath });
    request.once("aborted", () => frontDoorLog("front_request_aborted", { request_id: requestId }));
    response.once("finish", () => {
      requestFinished = true;
      frontDoorLog("front_request_finish", { request_id: requestId, status: response.statusCode, duration_ms: Date.now() - requestStartedAt });
    });
    response.once("close", () => {
      if (!requestFinished) frontDoorLog("front_request_close", { request_id: requestId, status: response.statusCode, duration_ms: Date.now() - requestStartedAt, writable_ended: response.writableEnded });
    });
  }
  if (request.method === "GET" && requestPath === "/health") {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.end(JSON.stringify({ status: "ok", name: "shell-mcp", host: HOST, port: PORT, pid: process.pid, active_requests: activeRequests, total_requests: totalRequests }));
    return;
  }
  try {
    const body = await readBody(request);
    const call = isMcpRequest ? parseMcpCall(body) : {};
    if (requestId) frontDoorLog("front_request_parsed", { request_id: requestId, tool: call.tool || null, process_id: call.processId || null, static_route: staticMatch?.route.slug || null });
    if (staticMatch) await proxyStaticRequest(request, response, body, staticMatch, requestId);
    else await proxyRequest(request, response, body, call, requestId);
  } catch (error) {
    if (!response.headersSent) {
      response.statusCode = error instanceof Error && error.message === "request_too_large" ? 413 : 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }
});

server.on("clientError", (error, socket) => {
  frontDoorLog("front_client_error", { code: "code" in error ? error.code : null, error: error.message });
  // Installing a clientError listener disables Node's default malformed-socket
  // cleanup. Always close the socket here so a Funnel-side reset or parse error
  // cannot leave a dead public connection retained by the stable front door.
  if (socket.writable && !("code" in error && error.code === "ECONNRESET")) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const target = backendTarget();
  console.error(`shell-mcp front door listening on http://${HOST}:${PORT}; backend=127.0.0.1:${target.port} generation=${target.generation}`);
});
server.keepAliveTimeout = 0;
server.headersTimeout = 40_000;
server.requestTimeout = 35_000;
server.timeout = 0;
const stop = () => {
  server.close(() => { backendAgent.destroy(); requestLogStream.end(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 5_000).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
