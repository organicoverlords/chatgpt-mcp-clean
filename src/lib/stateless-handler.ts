import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ServerFactory = () => McpServer;

export function createStatelessHandler(factory: ServerFactory) {
  let active = 0;
  let total = 0;

  return {
    active: () => active,
    total: () => total,
    async handle(req: Request, res: Response, body: unknown) {
      const server = factory();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      active++;
      total++;
      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        active--;
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
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
    },
  };
}
