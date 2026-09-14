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
const localFileToolName = (process.env.MCP_LOCAL_FILE_TOOL_NAME || "upload_local_file").trim();
assert.ok(["upload_local_file", "read_local_file"].includes(localFileToolName), `unsupported MCP_LOCAL_FILE_TOOL_NAME=${localFileToolName}`);
const librarySpoolBridgeEnabled = localFileToolName === "upload_local_file" && (process.env.MCP_LIBRARY_SPOOL_BRIDGE === "1" || (process.env.MCP_RUNTIME_INSTANCE_ID || "").startsWith("issue333-persistent-widget-"));
const readLocalFileDescription = "Read one exact local file and return its unchanged bytes as a native MCP file resource for ChatGPT. This read-only tool does not modify local state, mount an app/widget, or invoke the Library upload API. Transfers preserve exact bytes and SHA-256; images remain compact lazy resources and ZIP review members remain exact resource links.";
const readOutputBridgeDescription = "Read process stdout/stderr or mount the persistent visual-proof bridge with process_id=visual-proof. Ordinary start_process remains widget-free; the mounted bridge consumes later proofs without per-proof tool calls.";
const { createServer } = await import("../dist/server.js");
const { registerOptionalVisualProofTools } = await import("../dist/lib/visual-proof-registration.js");
const contractSourceCommit = "0123456789abcdef0123456789abcdef01234567";
const server = createServer("contract-verifier", { backend_generation: "backend-contract-test", source_commit: contractSourceCommit });
registerOptionalVisualProofTools(server, "contract-verifier");
const actualTools = Object.entries(server._registeredTools)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, tool]) => ({ name, description: tool.description || "", inputSchema: z.toJSONSchema(tool.inputSchema), ...(tool.outputSchema ? { outputSchema: z.toJSONSchema(tool.outputSchema) } : {}) }));

const expectedInvocationUi = {
  start_process: { title: "Run command", invoking: "Running command…", invoked: "Command returned" },
  read_output: { title: "Check command", invoking: "Checking command…", invoked: "Command checked" },
  kill_process: { title: "Stop process", invoking: "Stopping process…", invoked: "Process stop checked" },
  [localFileToolName]: localFileToolName === "read_local_file"
    ? { title: "Read local file", invoking: "Reading file…", invoked: "File ready" }
    : { title: "Share local file", invoking: "Preparing file…", invoked: "File ready" },
  download_chatgpt_file: { title: "Save ChatGPT file", invoking: "Saving file…", invoked: "File saved" },
};
for (const [name, expected] of Object.entries(expectedInvocationUi)) {
  const tool = server._registeredTools[name];
  assert.equal(tool?.title, expected.title, `${name} must expose its concise user-facing title`);
  assert.equal(tool?._meta?.["openai/toolInvocation/invoking"], expected.invoking, `${name} must expose concise invoking status`);
  assert.equal(tool?._meta?.["openai/toolInvocation/invoked"], expected.invoked, `${name} must expose concise invoked status`);
  assert.ok(expected.invoking.length <= 64 && expected.invoked.length <= 64, `${name} invocation statuses must stay within Apps SDK limits`);
}

const structuredProcessToolNames = ["start_process", "read_output", "kill_process"];
for (const name of structuredProcessToolNames) {
  assert.ok(server._registeredTools[name]?.outputSchema, `${name} must declare outputSchema`);
}

for (const name of ["start_process", ...(librarySpoolBridgeEnabled ? [] : ["read_output", localFileToolName])]) {
  const meta = server._registeredTools[name]?._meta;
  assert.equal(meta?.["openai/outputTemplate"], undefined, `${name} must not mount an app/widget template`);
  assert.equal(meta?.["ui/resourceUri"], undefined, `${name} must not advertise an app resource URI`);
  assert.equal(meta?.ui, undefined, `${name} must not advertise nested app UI metadata`);
}
if (librarySpoolBridgeEnabled) {
  for (const name of ["read_output", localFileToolName]) {
    const meta = server._registeredTools[name]?._meta;
    assert.equal(meta?.["openai/outputTemplate"], "ui://process/file-transfer-v7.html", `${name} persistent bridge must mount existing file-transfer widget`);
    assert.equal(meta?.ui?.resourceUri, "ui://process/file-transfer-v7.html", `${name} persistent bridge must advertise existing app resource URI`);
  }
}
const startInputSchema = server._registeredTools.start_process?.inputSchema;
assert.ok(startInputSchema, "start_process input schema missing");
assert.equal((await startInputSchema.safeParseAsync({ command: "Write-Output LEGACY" })).success, true, "legacy command input must remain valid");
assert.equal((await startInputSchema.safeParseAsync({ executable: "node", args: ["--version"], stdin: "" })).success, true, "structured executable+args+stdin input must be valid");
assert.equal((await startInputSchema.safeParseAsync({ command: "Write-Output BAD", executable: "node" })).success, false, "command and executable modes must be mutually exclusive");
assert.equal((await startInputSchema.safeParseAsync({ command: "Write-Output BAD", stdin: "x" })).success, false, "legacy command mode must reject structured stdin");

const readInputSchema = server._registeredTools.read_output?.inputSchema;
assert.ok(readInputSchema, "read_output input schema missing");
assert.equal((await readInputSchema.safeParseAsync({ process_id: "probe", max_chars: 0 })).success, true, "read_output max_chars=0 must be accepted and clamped instead of burning a retry turn");
assert.equal((await readInputSchema.safeParseAsync({ process_id: "probe", max_chars: -100 })).success, true, "read_output negative max_chars must be accepted and clamped instead of burning a retry turn");
assert.equal((await readInputSchema.safeParseAsync({ process_id: "probe", max_chars: 1_000_000 })).success, true, "read_output oversized max_chars must be accepted and clamped instead of burning a retry turn");

async function assertStructuredProcessResult(name, args) {
  const tool = server._registeredTools[name];
  const result = await tool.handler(args, {});
  assert.ok(result.structuredContent, `${name} must return structuredContent`);
  assert.deepEqual(result.structuredContent.serving_identity, {
    tool_contract_version: "process-tools.v3",
    backend_generation: "backend-contract-test",
    source_commit: contractSourceCommit,
  }, `${name} must expose exact serving backend/source/contract identity`);
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
const stdinStructured = await assertStructuredProcessResult("start_process", {
  executable: process.execPath,
  args: ["-e", "process.stdin.pipe(process.stdout)"],
  stdin: "contract-stdin\n",
  wait_ms: 10_000,
});
assert.equal(String(stdinStructured.stdout || ""), "contract-stdin\n", "structured stdin must reach the child without shell transport");
const readStructured = await assertStructuredProcessResult("read_output", { process_id: startStructured.process_id, max_chars: 32_000, wait_ms: 0 });
assert.equal(readStructured.process_id, startStructured.process_id, "read_output structured result must preserve process identity");
const tinyReadStructured = await assertStructuredProcessResult("read_output", { process_id: startStructured.process_id, max_chars: 0, wait_ms: 0 });
assert.ok(String(tinyReadStructured.stdout || "").length <= 1, "max_chars=0 must clamp to one retained character");
assert.equal(tinyReadStructured.output_page?.page_limit, 1, "max_chars=0 must expose the effective clamped page limit");
const oversizedReadStructured = await assertStructuredProcessResult("read_output", { process_id: startStructured.process_id, max_chars: 1_000_000, wait_ms: 0 });
assert.ok(String(oversizedReadStructured.stdout || "").length <= 32_000, "oversized max_chars must clamp to the transport cap");
const killStructured = await assertStructuredProcessResult("kill_process", { process_id: startStructured.process_id });
assert.equal(killStructured.already_exited, true, "kill_process structured regression probe should exercise already-exited variant");
const contractPath = resolve("config/process-tool-contract.json");
const contractBytes = readFileSync(contractPath);
const baseExpectedTools = JSON.parse(contractBytes.toString("utf8"));
// Freeze the semantic JSON contract, not checkout-specific CRLF/LF bytes. The previous raw-byte
// hash produced false failures in clean Windows worktrees even when the registered schema and
// descriptions were identical.
const acceptedContractSha256 = "9d9464bb514fb88e4e63ec88878fb0e186b029ea9fa45ca359917a731a2e49f3";
const actualContractSha256 = createHash("sha256").update(JSON.stringify(baseExpectedTools)).digest("hex");
assert.equal(actualContractSha256, acceptedContractSha256, "accepted production connector-tool contract changed; descriptions/schema are frozen and must not be used as an instruction channel without an explicit contract migration approved by the user");
const expectedTools = baseExpectedTools
  .map((tool) => librarySpoolBridgeEnabled && tool.name === "read_output"
    ? { ...tool, description: readOutputBridgeDescription }
    : localFileToolName === "read_local_file" && tool.name === "upload_local_file"
      ? { ...tool, name: "read_local_file", description: readLocalFileDescription }
      : tool)
  .sort((a, b) => a.name.localeCompare(b.name));
assert.deepEqual(actualTools, expectedTools, "connector tool contract changed; do not replace a stable connector identity without an explicit contract migration");
const serverBytes = readFileSync(resolve("dist/server.js"));
const actualHash = createHash("sha256").update(serverBytes).digest("hex");
const expectedHash = readFileSync(resolve("config/process-server.sha256"), "utf8").trim();
assert.equal(actualHash, expectedHash, "dist/server.js changed from the pinned stable implementation; replacement blocked");
console.log(`PASS process_contract_guard tools=${actualTools.map((tool) => tool.name).join(",")} server_sha256=${actualHash}`);
process.exit(0);
