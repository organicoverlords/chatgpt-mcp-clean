import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

// Verify the default server surface itself. Production launchers also set process
// explicitly, but the default must remain production-safe so audits/tests that omit
// deployment env cannot accidentally inspect the internal full profile.
delete process.env.MCP_TOOL_PROFILE;
process.env.MCP_VISUAL_PROOF_UI = "1";
process.env.MCP_VISUAL_PROOF_REVIEW = "1";
process.env.MCP_PROCESS_RECEIPT_DIR = resolve(".state/process-contract-verifier-receipts");
const { createServer } = await import("../dist/server.js");
const { registerOptionalVisualProofTools } = await import("../dist/lib/visual-proof-registration.js");
const server = createServer("contract-verifier");
registerOptionalVisualProofTools(server, "contract-verifier");
const actualTools = Object.entries(server._registeredTools)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, tool]) => ({ name, description: tool.description || "", inputSchema: z.toJSONSchema(tool.inputSchema), ...(tool.outputSchema ? { outputSchema: z.toJSONSchema(tool.outputSchema) } : {}) }));

const structuredProcessToolNames = ["start_process", "read_output", "kill_process"];
for (const name of structuredProcessToolNames) {
  assert.ok(server._registeredTools[name]?.outputSchema, `${name} must declare outputSchema`);
}

assert.equal(server._registeredTools.start_process?._meta, undefined, "start_process must remain widget/app-metadata free");
assert.equal(server._registeredTools.read_output?._meta, undefined, "read_output must remain widget/app-metadata free");
const startInputSchema = server._registeredTools.start_process?.inputSchema;
assert.ok(startInputSchema, "start_process input schema missing");
assert.equal((await startInputSchema.safeParseAsync({ command: "Write-Output LEGACY" })).success, true, "legacy command input must remain valid");
assert.equal((await startInputSchema.safeParseAsync({ executable: "node", args: ["--version"] })).success, true, "structured executable+args input must be valid");
assert.equal((await startInputSchema.safeParseAsync({ command: "Write-Output BAD", executable: "node" })).success, false, "command and executable modes must be mutually exclusive");

async function assertStructuredProcessResult(name, args) {
  const tool = server._registeredTools[name];
  const result = await tool.handler(args, {});
  assert.ok(result.structuredContent, `${name} must return structuredContent`);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, `${name} text and structured results must stay compatible`);
  const parsed = await tool.outputSchema.safeParseAsync(result.structuredContent);
  assert.ok(parsed.success, `${name} structuredContent must validate against outputSchema: ${parsed.error || "unknown error"}`);
  return result.structuredContent;
}

const startStructured = await assertStructuredProcessResult("start_process", { command: "Write-Output process-contract-structured", wait_ms: 10_000 });
assert.match(startStructured.stdout || "", /process-contract-structured/, "start_process structured output should preserve stdout");
const trickyArg = String.raw`space ; $dollar \"quote\" ` + "`tick";
const argvStructured = await assertStructuredProcessResult("start_process", {
  executable: process.execPath,
  args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", trickyArg],
  wait_ms: 10_000,
});
assert.equal(argvStructured.execution_mode, "native", "structured executable mode must bypass PowerShell");
assert.equal(argvStructured.execution_reason, "structured_argv", "structured executable mode must expose its routing reason");
assert.deepEqual(JSON.parse(String(argvStructured.stdout || "").trim()), [trickyArg], "structured argv must survive without shell reinterpretation");
const readStructured = await assertStructuredProcessResult("read_output", { process_id: startStructured.process_id, max_chars: 32_000, wait_ms: 0 });
assert.equal(readStructured.process_id, startStructured.process_id, "read_output structured result must preserve process identity");
const killStructured = await assertStructuredProcessResult("kill_process", { process_id: startStructured.process_id });
assert.equal(killStructured.already_exited, true, "kill_process structured regression probe should exercise already-exited variant");
const contractPath = resolve("config/process-tool-contract.json");
const contractBytes = readFileSync(contractPath);
const expectedTools = JSON.parse(contractBytes.toString("utf8"));
// Freeze the semantic JSON contract, not checkout-specific CRLF/LF bytes. The previous raw-byte
// hash produced false failures in clean Windows worktrees even when the registered schema and
// descriptions were identical.
const acceptedContractSha256 = "b7d301913dbae726d6216ccbf65b7eb42eceefc3d0027a35f838be66b478d5be";
const actualContractSha256 = createHash("sha256").update(JSON.stringify(expectedTools)).digest("hex");
assert.equal(actualContractSha256, acceptedContractSha256, "accepted production connector-tool contract changed; descriptions/schema are frozen and must not be used as an instruction channel without an explicit contract migration approved by the user");
assert.deepEqual(actualTools, expectedTools, "connector tool contract changed; do not replace a stable connector identity without an explicit contract migration");
const serverBytes = readFileSync(resolve("dist/server.js"));
const actualHash = createHash("sha256").update(serverBytes).digest("hex");
const expectedHash = readFileSync(resolve("config/process-server.sha256"), "utf8").trim();
assert.equal(actualHash, expectedHash, "dist/server.js changed from the pinned stable implementation; replacement blocked");
console.log(`PASS process_contract_guard tools=${actualTools.map((tool) => tool.name).join(",")} server_sha256=${actualHash}`);
process.exit(0);
