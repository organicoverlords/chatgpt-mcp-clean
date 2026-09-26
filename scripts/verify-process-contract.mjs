import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

// Verify the default server surface itself. Production launchers also set process
// explicitly, but the default must remain production-safe so audits/tests that omit
// deployment env cannot accidentally inspect the internal full profile.
delete process.env.MCP_TOOL_PROFILE;
process.env.MCP_DEFAULT_EXECUTION_TARGET = "local";
process.env.MCP_PROCESS_RECEIPT_DIR = resolve(".state/process-contract-verifier-receipts");
const omenFixture = resolve(".state/process-contract-omen-exec.py");
mkdirSync(resolve(".state"), { recursive: true });
writeFileSync(omenFixture, [
  "import subprocess, sys",
  "argv = sys.argv[1:]",
  "assert argv[:2] == ['--invocation-source', 'mcp'], argv",
  "idx = argv.index('--')",
  "raise SystemExit(subprocess.run(argv[idx + 1:]).returncode)",
  "",
].join("\n"), "utf8");
process.env.MCP_OMEN_EXEC_PATH = omenFixture;
const { createServer } = await import("../dist/server.js");
const contractSourceCommit = "0123456789abcdef0123456789abcdef01234567";
const server = createServer("contract-verifier", { backend_generation: "backend-contract-test", source_commit: contractSourceCommit });
const actualTools = Object.entries(server._registeredTools)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, tool]) => ({ name, description: tool.description || "", inputSchema: z.toJSONSchema(tool.inputSchema), ...(tool.outputSchema ? { outputSchema: z.toJSONSchema(tool.outputSchema) } : {}) }));

const toolsWithoutClientUiTitles = ["start_process", "read_output", "kill_process"];
for (const name of toolsWithoutClientUiTitles) {
  const tool = server._registeredTools[name];
  assert.equal(tool?.title, undefined, `${name} must not advertise client UI title metadata`);
  assert.equal(tool?._meta?.["openai/toolInvocation/invoking"], undefined, `${name} must not advertise invoking status metadata`);
  assert.equal(tool?._meta?.["openai/toolInvocation/invoked"], undefined, `${name} must not advertise invoked status metadata`);
}

const publicDescriptionBudget = 160;
const publicDescriptionInstructionLeak = /\b(?:wait_ms|max_chars|destination_path|overwrite|defaults?|input forms|do not|never|retry|poll(?:ing)?)\b/i;
for (const name of toolsWithoutClientUiTitles) {
  const description = server._registeredTools[name]?.description || "";
  assert.ok(description.length <= publicDescriptionBudget, `${name} description must stay capability-focused and <= ${publicDescriptionBudget} characters`);
  assert.doesNotMatch(description, publicDescriptionInstructionLeak, `${name} description must not duplicate schema/defaults or carry orchestration instructions`);
}

const structuredProcessToolNames = ["start_process", "read_output", "kill_process"];
for (const name of structuredProcessToolNames) {
  assert.ok(server._registeredTools[name]?.outputSchema, `${name} must declare outputSchema`);
}

for (const name of ["start_process", "read_output"]) {
  const meta = server._registeredTools[name]?._meta;
  assert.equal(meta?.["openai/outputTemplate"], undefined, `${name} must not mount an app/widget template`);
  assert.equal(meta?.["ui/resourceUri"], undefined, `${name} must not advertise an app resource URI`);
  assert.equal(meta?.ui, undefined, `${name} must not advertise nested app UI metadata`);
}
for (const forbidden of ["view_image", "upload_local_file", "read_local_file", "mount_visual_proof_bridge"]) {
  assert.equal(server._registeredTools[forbidden], undefined, `${forbidden} must not exist on the connector surface`);
}
const startInputSchema = server._registeredTools.start_process?.inputSchema;
assert.ok(startInputSchema, "start_process input schema missing");
assert.equal((await startInputSchema.safeParseAsync({ command: "Write-Output LEGACY" })).success, false, "legacy command input must be rejected");
assert.equal((await startInputSchema.safeParseAsync({ executable: "node", args: ["--version"], stdin: "" })).success, true, "structured executable+args+stdin input must be valid");
assert.equal((await startInputSchema.safeParseAsync({ execution_target: "omen", executable: "node", args: ["--version"], working_directory: "/tmp" })).success, true, "OMEN executable+args input must be valid");
assert.equal((await startInputSchema.safeParseAsync({ execution_target: "omen", language: "bash", script: "pwd" })).success, false, "OMEN script input must be rejected");
assert.equal((await startInputSchema.safeParseAsync({ execution_target: "omen", executable: "node", stdin: "x" })).success, false, "OMEN stdin must be rejected");
assert.equal((await startInputSchema.safeParseAsync({ execution_target: "omen", executable: "node", env: { X: "1" } })).success, false, "OMEN env overrides must be rejected");
assert.equal((await startInputSchema.safeParseAsync({ execution_target: "mars", executable: "node" })).success, false, "unknown execution targets must be rejected");

const readInputSchema = server._registeredTools.read_output?.inputSchema;
assert.ok(readInputSchema, "read_output input schema missing");
assert.equal((await startInputSchema.safeParseAsync({ executable: process.execPath, wait_ms: 240_000 })).success, true, "start_process must accept 240s explicit waits");
assert.equal((await startInputSchema.safeParseAsync({ executable: process.execPath, wait_ms: 240_001 })).success, false, "start_process must bound waits above 240s");
assert.equal((await readInputSchema.safeParseAsync({ process_id: "probe", wait_ms: 240_000 })).success, true, "read_output must accept 240s explicit waits");
assert.equal((await readInputSchema.safeParseAsync({ process_id: "probe", wait_ms: 240_001 })).success, false, "read_output must bound waits above 240s");
assert.equal((await readInputSchema.safeParseAsync({ process_id: "probe", max_chars: 0 })).success, true, "read_output max_chars=0 must be accepted and clamped instead of burning a retry turn");
assert.equal((await readInputSchema.safeParseAsync({ process_id: "probe", max_chars: -100 })).success, true, "read_output negative max_chars must be accepted and clamped instead of burning a retry turn");
assert.equal((await readInputSchema.safeParseAsync({ process_id: "probe", max_chars: 1_000_000 })).success, true, "read_output oversized max_chars must be accepted and clamped instead of burning a retry turn");

async function assertStructuredProcessResult(name, args) {
  const tool = server._registeredTools[name];
  const result = await tool.handler(args, {});
  assert.ok(result.structuredContent, `${name} must return structuredContent`);
  assert.deepEqual(result.structuredContent.serving_identity, {
    tool_contract_version: "process-tools.v4",
    backend_generation: "backend-contract-test",
    source_commit: contractSourceCommit,
  }, `${name} must expose exact serving backend/source/contract identity`);
  assert.deepEqual(result.content, [], `${name} must not duplicate structured process JSON into text content`);
  const parsed = await tool.outputSchema.safeParseAsync(result.structuredContent);
  assert.ok(parsed.success, `${name} structuredContent must validate against outputSchema: ${parsed.error || "unknown error"}`);
  return result.structuredContent;
}

const nativeOmenProxy = Boolean(String(process.env.MCP_OMEN_MCP_URL || "").trim());
const contractNodeExecutable = nativeOmenProxy ? "node" : process.execPath;
const startStructured = await assertStructuredProcessResult("start_process", nativeOmenProxy
  ? { language: "node", script: "console.log(\"process-contract-structured\")", wait_ms: 10_000 }
  : { language: "powershell", script: "Write-Output process-contract-structured", wait_ms: 10_000 });
assert.match(startStructured.stdout || "", /process-contract-structured/, "start_process structured output should preserve stdout");
const trickyArg = String.raw`space ; $dollar \"quote\" ` + "`tick";
const argvStructured = await assertStructuredProcessResult("start_process", {
  executable: contractNodeExecutable,
  args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", trickyArg],
  wait_ms: 10_000,
});
assert.equal(argvStructured.execution_mode, "native", "structured executable mode must bypass PowerShell");
assert.equal(argvStructured.execution_reason, "structured_argv", "structured executable mode must expose its routing reason");
assert.deepEqual(JSON.parse(String(argvStructured.stdout || "").trim()), [trickyArg], "structured argv must survive without shell reinterpretation");
const omenStructured = await assertStructuredProcessResult("start_process", {
  execution_target: "omen",
  executable: contractNodeExecutable,
  args: ["-e", "console.log('omen-target-contract')"],
  working_directory: "/tmp",
  wait_ms: 10_000,
});
assert.equal(omenStructured.execution_target, "omen", "OMEN execution must identify the selected target");
assert.equal(omenStructured.execution_transport, nativeOmenProxy ? "native-mcp" : "ssh-adapter", nativeOmenProxy
  ? "native OMEN MCP proxy must identify native MCP transport explicitly"
  : "Windows legacy OMEN adapter must identify SSH transport explicitly");
assert.match(String(omenStructured.stdout || ""), /omen-target-contract/, "OMEN target wrapper must execute the requested argv");
const stdinStructured = await assertStructuredProcessResult("start_process", {
  executable: contractNodeExecutable,
  args: ["-e", "process.stdin.pipe(process.stdout)"],
  stdin: "contract-stdin\n",
  wait_ms: 10_000,
});
assert.equal(String(stdinStructured.stdout || ""), "contract-stdin\n", "structured stdin must reach the child without shell transport");
const readStructured = await assertStructuredProcessResult("read_output", { process_id: startStructured.process_id, max_chars: 256_000, wait_ms: 0 });
assert.equal(readStructured.process_id, startStructured.process_id, "read_output structured result must preserve process identity");
const tinyReadStructured = await assertStructuredProcessResult("read_output", { process_id: startStructured.process_id, max_chars: 0, wait_ms: 0 });
assert.ok(String(tinyReadStructured.stdout || "").length <= 1, "max_chars=0 must clamp to one retained character");
assert.equal(tinyReadStructured.output_page?.page_limit, 1, "max_chars=0 must expose the effective clamped page limit");
const oversizedReadStructured = await assertStructuredProcessResult("read_output", { process_id: startStructured.process_id, max_chars: 1_000_000, wait_ms: 0 });
assert.ok(String(oversizedReadStructured.stdout || "").length <= 256_000, "oversized max_chars must clamp to the 256k transport page cap");
const killStructured = await assertStructuredProcessResult("kill_process", { process_id: startStructured.process_id });
assert.equal(killStructured.already_exited, true, "kill_process structured regression probe should exercise already-exited variant");
const contractPath = resolve("config/process-tool-contract.json");
const contractBytes = readFileSync(contractPath);
const baseExpectedTools = JSON.parse(contractBytes.toString("utf8"));
// Freeze the semantic JSON contract, not checkout-specific CRLF/LF bytes. The previous raw-byte
// hash produced false failures in clean Windows worktrees even when the registered schema and
// descriptions were identical.
const acceptedContractSha256 = "fb9569c0e2797abd08a577f61319e648856c63554e4eb175cf4d4586860f5ee6";
const actualContractSha256 = createHash("sha256").update(JSON.stringify(baseExpectedTools)).digest("hex");
assert.equal(actualContractSha256, acceptedContractSha256, "accepted production connector-tool contract changed; descriptions/schema are frozen and must not be used as an instruction channel without an explicit contract migration approved by the user");
const expectedTools = [...baseExpectedTools].sort((a, b) => a.name.localeCompare(b.name));
assert.deepEqual(actualTools, expectedTools, "connector tool contract changed; do not replace a stable connector identity without an explicit contract migration");
const serverBytes = readFileSync(resolve("dist/server.js"));
const actualHash = createHash("sha256").update(serverBytes).digest("hex");
const expectedHash = readFileSync(resolve("config/process-server.sha256"), "utf8").trim();
assert.equal(actualHash, expectedHash, "dist/server.js changed from the pinned stable implementation; replacement blocked");
console.log(`PASS process_contract_guard tools=${actualTools.map((tool) => tool.name).join(",")} server_sha256=${actualHash}`);
process.exit(0);
