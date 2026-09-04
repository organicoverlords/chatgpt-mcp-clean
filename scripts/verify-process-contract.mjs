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
const contractPath = resolve("config/process-tool-contract.json");
const contractBytes = readFileSync(contractPath);
const expectedTools = JSON.parse(contractBytes.toString("utf8"));
// Freeze the semantic JSON contract, not checkout-specific CRLF/LF bytes. The previous raw-byte
// hash produced false failures in clean Windows worktrees even when the registered schema and
// descriptions were identical.
const acceptedContractSha256 = "5b12fae0a986f8d59d48e06ac0a6625fd57a91708c0f2d00d734599fca178f37";
const actualContractSha256 = createHash("sha256").update(JSON.stringify(expectedTools)).digest("hex");
assert.equal(actualContractSha256, acceptedContractSha256, "accepted production process-tool contract changed; descriptions/schema are frozen and must not be used as an instruction channel without an explicit contract migration approved by the user");
assert.deepEqual(actualTools, expectedTools, "process tool contract changed; do not replace a stable connector identity without an explicit contract migration");
const serverBytes = readFileSync(resolve("dist/server.js"));
const actualHash = createHash("sha256").update(serverBytes).digest("hex");
const expectedHash = readFileSync(resolve("config/process-server.sha256"), "utf8").trim();
assert.equal(actualHash, expectedHash, "dist/server.js changed from the pinned stable implementation; replacement blocked");
console.log(`PASS process_contract_guard tools=${actualTools.map((tool) => tool.name).join(",")} server_sha256=${actualHash}`);
