import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Request } from "express";

export interface McpRequestContext {
  actorId?: string;
  callerKey?: string;
  requestId?: string | number;
  identitySource?: "openai-session" | "mcp-binding" | "mcp-session";
}

interface SessionActorBinding {
  actor_id: string;
  last_seen: string;
}

interface BindingFile {
  version: 1;
  bindings: Record<string, SessionActorBinding>;
}

const storage = new AsyncLocalStorage<McpRequestContext>();
const bindingPath = () => process.env.MCP_ACTOR_BINDINGS_PATH || path.resolve(process.cwd(), ".mcp-state", "actor-bindings.json");
const MAX_BINDINGS = 2048;
const BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let bindingsLoaded = false;
let bindings: Record<string, SessionActorBinding> = {};
let bindingWriteChain: Promise<void> = Promise.resolve();

function firstHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) return value[0].trim();
  return undefined;
}

function hashIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function actorFromOpenAiSession(value: string): string {
  return `actor_${hashIdentity(`openai-session:${value}`).slice(0, 12)}`;
}

function actorFromMcpSession(value: string): string {
  return `actor_${hashIdentity(`mcp-session-fallback:${value}`).slice(0, 12)}`;
}

function bindingKey(value: string): string {
  return hashIdentity(`mcp-session:${value}`);
}

async function loadBindings(): Promise<void> {
  if (bindingsLoaded) return;
  bindingsLoaded = true;
  try {
    const parsed = JSON.parse(await fs.readFile(bindingPath(), "utf8")) as Partial<BindingFile>;
    if (parsed.version === 1 && parsed.bindings && typeof parsed.bindings === "object") {
      const cutoff = Date.now() - BINDING_TTL_MS;
      for (const [key, value] of Object.entries(parsed.bindings)) {
        if (!value || typeof value.actor_id !== "string" || typeof value.last_seen !== "string") continue;
        if (Date.parse(value.last_seen) < cutoff) continue;
        bindings[key] = { actor_id: value.actor_id, last_seen: value.last_seen };
      }
    }
  } catch {}
}

function persistBindingsSoon(): Promise<void> {
  bindingWriteChain = bindingWriteChain.then(async () => {
    const ordered = Object.entries(bindings)
      .sort((a, b) => Date.parse(b[1].last_seen) - Date.parse(a[1].last_seen))
      .slice(0, MAX_BINDINGS);
    bindings = Object.fromEntries(ordered);
    const file = bindingPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ version: 1, bindings } satisfies BindingFile, null, 2) + "\n", "utf8");
    await fs.rename(temp, file);
  }).catch(() => {});
  return bindingWriteChain;
}

async function bindSessionActor(mcpSession: string, actorId: string): Promise<void> {
  await loadBindings();
  bindings[bindingKey(mcpSession)] = { actor_id: actorId, last_seen: new Date().toISOString() };
  await persistBindingsSoon();
}

async function resolveActor(openAiSession: string | undefined, mcpSession: string | undefined): Promise<{ actorId?: string; source?: McpRequestContext["identitySource"] }> {
  if (openAiSession) {
    const actorId = actorFromOpenAiSession(openAiSession);
    if (mcpSession) await bindSessionActor(mcpSession, actorId);
    return { actorId, source: "openai-session" };
  }
  if (!mcpSession) return {};

  await loadBindings();
  const bound = bindings[bindingKey(mcpSession)];
  if (bound) {
    bound.last_seen = new Date().toISOString();
    void persistBindingsSoon();
    return { actorId: bound.actor_id, source: "mcp-binding" };
  }

  const actorId = actorFromMcpSession(mcpSession);
  await bindSessionActor(mcpSession, actorId);
  return { actorId, source: "mcp-session" };
}

async function buildContext(openAiSession: string | undefined, mcpSession: string | undefined, requestId: string | number | undefined): Promise<McpRequestContext> {
  const basis = openAiSession ? `openai-session:${openAiSession}` : mcpSession ? `mcp-session:${mcpSession}` : undefined;
  const callerKey = basis ? hashIdentity(basis) : undefined;
  const identity = await resolveActor(openAiSession, mcpSession);
  return { actorId: identity.actorId, identitySource: identity.source, callerKey, requestId };
}

export async function runWithMcpRequestContext<T>(req: Request, fn: () => Promise<T>): Promise<T> {
  const rawId = req.body && typeof req.body === "object" && "id" in req.body ? (req.body as { id?: unknown }).id : undefined;
  const requestId = typeof rawId === "string" || typeof rawId === "number" ? rawId : undefined;
  const internalRecovery = firstHeader(req, "x-mcp-internal-recovery") === "1";
  const context: McpRequestContext = internalRecovery
    ? { requestId }
    : await buildContext(firstHeader(req, "x-openai-session"), firstHeader(req, "mcp-session-id"), requestId);
  return storage.run(context, fn);
}

type HandlerExtraLike = {
  requestId?: string | number;
  sessionId?: string;
  requestInfo?: { headers?: Record<string, string | string[] | undefined> };
};

function firstHeaderValue(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) return value[0].trim();
  return undefined;
}

export async function runWithMcpHandlerContext<T>(extra: HandlerExtraLike | undefined, fn: () => Promise<T>): Promise<T> {
  const headers = extra?.requestInfo?.headers;
  const context = await buildContext(
    firstHeaderValue(headers, "x-openai-session"),
    firstHeaderValue(headers, "mcp-session-id") ?? extra?.sessionId,
    extra?.requestId
  );
  return storage.run(context, fn);
}

export async function bindMcpSessionToCurrentActor(mcpSession: string, preferredActorId?: string): Promise<string> {
  const store = storage.getStore();
  const actorId = preferredActorId ?? store?.actorId ?? actorFromMcpSession(mcpSession);
  await bindSessionActor(mcpSession, actorId);
  if (store && !store.actorId) {
    store.actorId = actorId;
    store.identitySource = "mcp-session";
  }
  return actorId;
}

export function getMcpRequestContext(): McpRequestContext | undefined {
  return storage.getStore();
}

export function getMcpActorId(): string | undefined {
  return storage.getStore()?.actorId;
}

export function getMcpRequestReplayKey(): string | undefined {
  const context = storage.getStore();
  if (!context?.callerKey || context.requestId === undefined) return undefined;
  return `${context.callerKey}:${String(context.requestId)}`;
}
