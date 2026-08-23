#!/usr/bin/env node
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import express, { type Request, type Response } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LocalOAuthProvider } from "./lib/local-oauth-provider.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ORIGIN = (process.env.MCP_PUBLIC_ORIGIN || "").trim();
const OWNER = (process.env.TAILSCALE_OWNER_LOGIN || "").trim().toLowerCase();
const STORE = process.env.MCP_OAUTH_STORE_PATH || ".state/oauth.json";

if (HOST !== "127.0.0.1" || PORT !== 3000) throw new Error("This server is fixed to 127.0.0.1:3000");
if (!ORIGIN || !OWNER) throw new Error("MCP_PUBLIC_ORIGIN and TAILSCALE_OWNER_LOGIN are required");

const publicOrigin = new URL(ORIGIN);
if (publicOrigin.protocol !== "https:" || !publicOrigin.hostname.endsWith(".ts.net")) throw new Error("MCP_PUBLIC_ORIGIN must be an HTTPS .ts.net origin");
const resource = new URL("/mcp", publicOrigin);
const oauth = new LocalOAuthProvider(resource, OWNER, STORE);
const bearer = requireBearerAuth({ verifier: oauth, requiredScopes: ["mcp"], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) });

const transportLogPath = resolve(process.env.MCP_TRANSPORT_LOG_PATH || ".state/transport.jsonl");
mkdirSync(dirname(transportLogPath), { recursive: true });
let activeRequests = 0;
let totalRequests = 0;

function transportLog(event: Record<string, unknown>): void {
  try {
    appendFileSync(transportLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
  } catch (error) {
    console.error("transport telemetry write failed:", error instanceof Error ? error.message : String(error));
  }
}

function jsonError(res: Response, status: number, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

async function handleStateless(req: Request, res: Response, body: unknown): Promise<void> {
  const server: McpServer = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    allowedHosts: ["127.0.0.1:3000", "localhost:3000", publicOrigin.host],
    enableDnsRebindingProtection: true,
  });
  activeRequests += 1;
  totalRequests += 1;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    activeRequests -= 1;
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

async function handleMcp(req: Request, res: Response): Promise<void> {
  try {
    await handleStateless(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error instanceof Error ? error.message : String(error));
    jsonError(res, 500, "Internal MCP server error");
  }
}

const app = express();
app.set("trust proxy", "loopback");
app.use((req, res, next) => {
  const requestId = randomUUID();
  const startedAt = process.hrtime.bigint();
  const host = req.header("host") || "";
  const viaFunnel = host.toLowerCase() === publicOrigin.host.toLowerCase();
  let finished = false;
  const durationMs = () => Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  transportLog({ event: "request_start", request_id: requestId, method: req.method, path: req.path, via_funnel: viaFunnel, remote_address: req.socket.remoteAddress || null });
  res.setHeader("x-shell-mcp-request-id", requestId);
  res.on("finish", () => {
    finished = true;
    transportLog({ event: "response_finish", request_id: requestId, method: req.method, path: req.path, via_funnel: viaFunnel, mcp_method: res.locals.mcpMethod || null, mcp_tool: res.locals.mcpTool || null, status: res.statusCode, duration_ms: Number(durationMs().toFixed(3)) });
  });
  res.on("close", () => {
    if (!finished) transportLog({ event: "response_close_early", request_id: requestId, method: req.method, path: req.path, via_funnel: viaFunnel, mcp_method: res.locals.mcpMethod || null, mcp_tool: res.locals.mcpTool || null, status: res.statusCode, duration_ms: Number(durationMs().toFixed(3)) });
  });
  req.on("aborted", () => transportLog({ event: "request_aborted", request_id: requestId, method: req.method, path: req.path, via_funnel: viaFunnel, mcp_method: res.locals.mcpMethod || null, mcp_tool: res.locals.mcpTool || null, duration_ms: Number(durationMs().toFixed(3)) }));
  req.once("error", (error) => transportLog({ event: "request_error", request_id: requestId, method: req.method, path: req.path, via_funnel: viaFunnel, mcp_method: res.locals.mcpMethod || null, mcp_tool: res.locals.mcpTool || null, code: "code" in error ? error.code : null, duration_ms: Number(durationMs().toFixed(3)) }));
  next();
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
  next();
});
app.get("/.well-known/openid-configuration", (_req, res) => res.json({
  issuer: publicOrigin.href,
  authorization_endpoint: new URL("/authorize", publicOrigin).href,
  token_endpoint: new URL("/token", publicOrigin).href,
  registration_endpoint: new URL("/register", publicOrigin).href,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["mcp", "offline_access"],
}));
app.use(mcpAuthRouter({ provider: oauth, issuerUrl: publicOrigin, resourceServerUrl: resource, scopesSupported: ["mcp", "offline_access"], resourceName: "Shell MCP", clientRegistrationOptions: { rateLimit: { windowMs: 60 * 60 * 1000, max: 300 } } }));

app.post("/mcp", bearer, handleMcp);
app.get("/mcp", bearer, (_req, res) => res.status(405).set("Allow", "POST").send("Method not allowed."));
app.delete("/mcp", bearer, (_req, res) => res.status(405).set("Allow", "POST").send("Method not allowed."));
app.get("/health", (_req, res) => res.json({ status: "ok", name: "shell-mcp", host: HOST, port: PORT, active_requests: activeRequests, total_requests: totalRequests }));

const httpServer = app.listen(PORT, HOST, () => console.error(`shell-mcp listening on http://${HOST}:${PORT}/mcp`));
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 75_000;
httpServer.requestTimeout = 0;
httpServer.timeout = 0;

process.on("uncaughtExceptionMonitor", (error, origin) => {
  transportLog({ event: "process_uncaught_exception", origin, error: error.message, stack: error.stack || null });
});
process.on("exit", (code) => transportLog({ event: "process_exit", code }));
httpServer.on("error", (error) => transportLog({ event: "http_server_error", error: error.message, code: "code" in error ? error.code : null }));

const stop = (signal: "SIGINT" | "SIGTERM") => {
  transportLog({ event: "process_signal", signal });
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
