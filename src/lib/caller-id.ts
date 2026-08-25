import { createHash } from "node:crypto";
import type { Request } from "express";

type HeaderRequest = Request | globalThis.Request;

/** Stable pseudonymous ID for live tool cards and transport logs. */
export function callerId(req: HeaderRequest): string {
  const header = (name: string): string | undefined => {
    const expressRequest = req as Request;
    if (typeof expressRequest.header === "function") return expressRequest.header(name);
    return (req as globalThis.Request).headers.get(name) || undefined;
  };
  const identity = header("x-openai-session")
    || header("mcp-session-id")
    || header("authorization")
    || ("ip" in req ? req.ip : undefined)
    || "unknown";
  return `caller_${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}
