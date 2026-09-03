#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import express, { type Request, type Response } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { callerId } from "./lib/caller-id.js";
import { LocalOAuthProvider } from "./lib/local-oauth-provider.js";
import { observeSocket, sessionFingerprint, setTelemetrySink, withTelemetryContext } from "./lib/transport-telemetry.js";
import { createResponseByteCounter } from "./lib/response-bytes.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ORIGIN = (process.env.MCP_PUBLIC_ORIGIN || "").trim();
const OWNER = (process.env.TAILSCALE_OWNER_LOGIN || "").trim().toLowerCase();
const STORE = process.env.MCP_OAUTH_STORE_PATH || ".state/oauth.json";

const backendMode = process.env.MCP_BACKEND_MODE === "1";
const forceConnectionClose = process.env.MCP_FORCE_CONNECTION_CLOSE === "1";
const frontDoorHost = (process.env.MCP_FRONT_DOOR_HOST || "127.0.0.1:3003").toLowerCase();
const backendGeneration = backendMode ? (process.env.MCP_BACKEND_GENERATION || `backend-${PORT}-${process.pid}-${Date.now()}`) : undefined;
if (HOST !== "127.0.0.1") throw new Error("This server is fixed to loopback");
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("PORT must be a non-privileged TCP port");
if (PORT !== 3000 && !backendMode) throw new Error("Alternate loopback ports require MCP_BACKEND_MODE=1");
if (!ORIGIN || !OWNER) throw new Error("MCP_PUBLIC_ORIGIN and TAILSCALE_OWNER_LOGIN are required");

const publicOrigin = new URL(ORIGIN);
if (publicOrigin.protocol !== "https:" || !publicOrigin.hostname.endsWith(".ts.net") || publicOrigin.search || publicOrigin.hash) throw new Error("MCP_PUBLIC_ORIGIN must be an HTTPS .ts.net origin without query or fragment");
if (!publicOrigin.pathname.endsWith("/")) publicOrigin.pathname += "/";
const publicBasePath = publicOrigin.pathname === "/" ? "" : publicOrigin.pathname.replace(/\/$/, "");
const publicUrl = (path: string): URL => new URL(path.replace(/^\/+/, ""), publicOrigin);
const resource = publicUrl("mcp");
const oauth = new LocalOAuthProvider(resource, OWNER, STORE);
const bearer = requireBearerAuth({ verifier: oauth, requiredScopes: ["mcp"], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) });

const transportLogPath = resolve(process.env.MCP_TRANSPORT_LOG_PATH || ".state/transport.jsonl");
mkdirSync(dirname(transportLogPath), { recursive: true });
const transportLogStream = createWriteStream(transportLogPath, { flags: "a", encoding: "utf8" });
transportLogStream.on("error", (error) => console.error("transport telemetry stream failed:", error.message));
let activeRequests = 0;
let totalRequests = 0;

function transportLog(event: Record<string, unknown>): void {
  try {
    if (!transportLogStream.destroyed) {
      transportLogStream.write(`${JSON.stringify({ at: new Date().toISOString(), server_pid: process.pid, ...event })}
`);
    }
  } catch (error) {
    console.error("transport telemetry write failed:", error instanceof Error ? error.message : String(error));
  }
}

function jsonError(res: Response, status: number, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

async function handleStateless(req: Request, res: Response, body: unknown): Promise<void> {
  const server: McpServer = createServer(callerId(req));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    allowedHosts: [`127.0.0.1:${PORT}`, `localhost:${PORT}`, frontDoorHost, publicOrigin.host],
    enableDnsRebindingProtection: true,
  });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  res.once("finish", () => void cleanup());
  res.once("close", () => void cleanup());
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    await cleanup();
    throw error;
  }
}
setTelemetrySink(transportLog);

async function handleMcp(req: Request, res: Response): Promise<void> {
  activeRequests += 1;
  totalRequests += 1;
  try {
    await handleStateless(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error instanceof Error ? error.message : String(error));
    jsonError(res, 500, "Internal MCP server error");
  } finally {
    activeRequests -= 1;
  }
}

const app = express();
app.set("trust proxy", "loopback");
if (forceConnectionClose) {
  app.use((_req, res, next) => {
    res.setHeader("connection", "close");
    next();
  });
}
app.use((req, res, next) => {
  const requestId = randomUUID();
  const requestCallerId = callerId(req);
  const connectionId = observeSocket(req.socket);
  const sessionId = sessionFingerprint(req.header("mcp-session-id") || req.header("x-openai-session"));
  const startedAt = process.hrtime.bigint();
  const host = req.header("host") || "";
  const viaFunnel = host.toLowerCase() === publicOrigin.host.toLowerCase();
  let finished = false;
  let responseBytes = 0;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const byteCounter = createResponseByteCounter((bytes) => { responseBytes = bytes; });
  res.write = ((chunk: any, encoding?: any, callback?: any) => { byteCounter.count(chunk, encoding); return originalWrite(chunk, encoding, callback); }) as typeof res.write;
  res.end = ((chunk?: any, encoding?: any, callback?: any) => { if (chunk != null) byteCounter.count(chunk, encoding); byteCounter.finish(); return originalEnd(chunk, encoding, callback); }) as typeof res.end;
  const durationMs = () => Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  transportLog({ event: "request_start", request_id: requestId, caller_id: requestCallerId, connection_id: connectionId, session_id: sessionId, method: req.method, path: req.path, via_funnel: viaFunnel, remote_address: req.socket.remoteAddress || null });
  res.setHeader("x-shell-mcp-request-id", requestId);
  res.on("finish", () => {
    finished = true;
    transportLog({ event: "response_finish", request_id: requestId, caller_id: requestCallerId, connection_id: connectionId, session_id: sessionId, method: req.method, path: req.path, via_funnel: viaFunnel, mcp_method: res.locals.mcpMethod || null, mcp_tool: res.locals.mcpTool || null, status: res.statusCode, response_bytes: responseBytes, duration_ms: Number(durationMs().toFixed(3)) });
  });
  res.on("close", () => {
    if (!finished) transportLog({ event: "response_close_early", request_id: requestId, caller_id: requestCallerId, connection_id: connectionId, session_id: sessionId, method: req.method, path: req.path, via_funnel: viaFunnel, mcp_method: res.locals.mcpMethod || null, mcp_tool: res.locals.mcpTool || null, status: res.statusCode, response_bytes: responseBytes, duration_ms: Number(durationMs().toFixed(3)) });
  });
  req.on("aborted", () => transportLog({ event: "request_aborted", request_id: requestId, caller_id: requestCallerId, connection_id: connectionId, session_id: sessionId, method: req.method, path: req.path, via_funnel: viaFunnel, mcp_method: res.locals.mcpMethod || null, mcp_tool: res.locals.mcpTool || null, duration_ms: Number(durationMs().toFixed(3)) }));
  req.once("error", (error) => transportLog({ event: "request_error", request_id: requestId, caller_id: requestCallerId, connection_id: connectionId, session_id: sessionId, method: req.method, path: req.path, via_funnel: viaFunnel, mcp_method: res.locals.mcpMethod || null, mcp_tool: res.locals.mcpTool || null, code: "code" in error ? error.code : null, duration_ms: Number(durationMs().toFixed(3)) }));
  withTelemetryContext({ request_id: requestId, caller_id: requestCallerId, connection_id: connectionId, session_id: sessionId }, next);
});
app.use(express.json({ limit: "4mb" }));
app.use((req, res, next) => {
  if (req.path === "/mcp" && req.method === "POST" && req.body && typeof req.body === "object") {
    const body = req.body as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    res.locals.mcpMethod = typeof body.method === "string" ? body.method : null;
    res.locals.mcpTool = typeof body.params?.name === "string" ? body.params.name : null;
    // `arguments` is optional in tools/call per spec, but a declared inputSchema makes
    // the SDK reject `undefined` outright. Normalise to {} so no-argument tools accept
    // both call forms instead of failing for clients that omit the key.
    if (body.method === "tools/call" && body.params && body.params.arguments === undefined) {
      body.params.arguments = {};
    }
  }
  next();
});

app.use("/authorize", (req, res, next) => {
  const login = (req.header("tailscale-user-login") || "").trim().toLowerCase();
  if (login && login !== OWNER) {
    res.status(403).send("Owner authorization required");
    return;
  }
  if (login === OWNER && req.method === "GET") {
    const clientId = typeof req.query.client_id === "string" ? req.query.client_id : "";
    const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
    if (clientId && redirectUri) oauth.recoverLegacyChatGptClient(clientId, redirectUri);
  }
  next();
});
const oauthMetadata = {
  issuer: publicOrigin.href,
  authorization_endpoint: publicUrl("authorize").href,
  token_endpoint: publicUrl("token").href,
  registration_endpoint: publicUrl("register").href,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["mcp", "offline_access"],
};

app.get("/.well-known/openid-configuration", (_req, res) => res.json(oauthMetadata));
// Path-scoped connector identities use RFC 8414 discovery with the issuer path
// inserted after the well-known prefix. Keep these explicit routes ahead of the
// SDK router because its authorization endpoint generation is root-oriented.
if (publicBasePath) {
  app.get(`/.well-known/oauth-authorization-server${publicBasePath}`, (_req, res) => res.json(oauthMetadata));
  app.get(`/.well-known/openid-configuration${publicBasePath}`, (_req, res) => res.json(oauthMetadata));
}
// Traycer probes the RFC 8414 path relative to the protected resource before
// falling back to the issuer root. The root-origin compatibility route stays
// available for the existing production connector.
app.get("/.well-known/oauth-authorization-server/mcp", (_req, res) => res.json(oauthMetadata));
app.use(mcpAuthRouter({ provider: oauth, issuerUrl: publicOrigin, resourceServerUrl: resource, scopesSupported: ["mcp", "offline_access"], resourceName: "Shell MCP", clientRegistrationOptions: { rateLimit: { windowMs: 60 * 60 * 1000, max: 300 } } }));

const allowedMcpHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, frontDoorHost, publicOrigin.host.toLowerCase()]);
app.use("/mcp", (req, res, next) => {
  const host = (req.header("host") || "").toLowerCase();
  if (!allowedMcpHosts.has(host)) {
    res.status(403).send("Invalid Host header");
    return;
  }
  next();
});
app.post("/mcp", bearer, handleMcp);
app.get("/mcp", bearer, (_req, res) => res.status(405).set("Allow", "POST").send("Method not allowed."));
app.delete("/mcp", bearer, (_req, res) => res.status(405).set("Allow", "POST").send("Method not allowed."));
app.get("/health", (_req, res) => res.json({ status: "ok", name: "shell-mcp", role: backendMode ? "backend" : "direct", ...(backendGeneration ? { backend_generation: backendGeneration } : {}), host: HOST, port: PORT, pid: process.pid, active_requests: activeRequests, total_requests: totalRequests, force_connection_close: forceConnectionClose }));

const httpServer = app.listen(PORT, HOST, () => console.error(`shell-mcp listening on http://${HOST}:${PORT}/mcp`));
httpServer.on("connection", (socket) => { observeSocket(socket); });
// MCP Streamable HTTP sessions may legitimately remain idle for longer than a minute.
// Do not let Node reap an otherwise healthy connection; the MCP client/server protocol
// owns session lifetime, while requestTimeout remains bounded for individual calls.
httpServer.keepAliveTimeout = 0;
// MCP calls are deliberately background/immediate; a client body that takes
// longer than this is a stalled connector upload, not useful long-running work.
// Keep a broken request from holding the route indefinitely while the worker
// reconnects and retries with the same process_id.
httpServer.headersTimeout = 35_000;
httpServer.requestTimeout = 30_000;
httpServer.timeout = 0;

process.on("uncaughtExceptionMonitor", (error, origin) => {
  transportLog({ event: "process_uncaught_exception", origin, error: error.message, stack: error.stack || null });
});
process.on("exit", (code) => transportLog({ event: "process_exit", code }));
httpServer.on("error", (error) => transportLog({ event: "http_server_error", error: error.message, code: "code" in error ? error.code : null }));

const stop = (signal: "SIGINT" | "SIGTERM") => {
  transportLog({ event: "process_signal", signal });
  httpServer.close(() => transportLogStream.end(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5_000).unref();
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
