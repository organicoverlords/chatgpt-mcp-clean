import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

process.env.MCP_TOOL_PROFILE = "process";
const { createServer } = await import("../dist/server.js");
const server = createServer("contract-verifier");
const actualTools = Object.entries(server._registeredTools)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, tool]) => ({ name, description: tool.description || "", inputSchema: z.toJSONSchema(tool.inputSchema) }));
const expectedTools = JSON.parse(readFileSync(resolve("config/process-tool-contract.json"), "utf8"));
assert.deepEqual(actualTools, expectedTools, "process tool contract changed; do not replace a stable connector identity without an explicit contract migration");
const serverBytes = readFileSync(resolve("dist/server.js"));
const actualHash = createHash("sha256").update(serverBytes).digest("hex");
const expectedHash = readFileSync(resolve("config/process-server.sha256"), "utf8").trim();
assert.equal(actualHash, expectedHash, "dist/server.js changed from the pinned stable implementation; replacement blocked");
console.log(`PASS process_contract_guard tools=${actualTools.map((tool) => tool.name).join(",")} server_sha256=${actualHash}`);
