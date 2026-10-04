import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const directory = mkdtempSync(join(tmpdir(), "mcp-call-diagnostics-"));
process.env.MCP_PROCESS_AUDIT_PATH = join(directory, "calls.jsonl");
process.env.MCP_LOCAL_ENGINE_URL = "http://127.0.0.1:3555/mcp";
process.env.MCP_TOOL_PROFILE = "process";
const { createServer } = await import("../dist/server.js");
const { auditProcessRequest, auditProcessResponse, flushProcessAudit } = await import("../dist/lib/process-call-audit.js");
const server = createServer("diagnostic-regression-fixture");
const client = new Client({ name: "diagnostic-regression-fixture", version: "1" });
const [left, right] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(left), client.connect(right)]);
const owned = new Set();
async function call(name, args) {
  auditProcessRequest(name, args);
  const reply = await client.callTool({ name, arguments: args });
  auditProcessResponse(name, { jsonrpc: "2.0", id: "fixture", result: reply });
  return reply;
}
async function complete(args) {
  let reply = await call("start_process", args);
  assert.equal(reply.isError, undefined, JSON.stringify(reply));
  let output = reply.structuredContent;
  assert.ok(output?.process_id);
  owned.add(output.process_id);
  const deadline = Date.now() + 20_000;
  let stdout = output.stdout ?? "", stderr = output.stderr ?? "";
  while (output.next_action === "READ_SAME_PROCESS_ID" && Date.now() < deadline) {
    reply = await call("read_output", { process_id: output.process_id, wait_ms: 1_000 });
    assert.equal(reply.isError, undefined, JSON.stringify(reply));
    output = reply.structuredContent;
    stdout += output.stdout ?? ""; stderr += output.stderr ?? "";
  }
  assert.equal(output.running, false, "finite fixture did not finish");
  owned.delete(output.process_id);
  return { ...output, stdout, stderr };
}
try {
  const args = ["api", "repos/organicoverlords/rust-v5", "--jq", ".full_name"];
  const native = await complete({ executable: "gh", args, wait_ms: 1_000 });
  const shell = await complete({ language: "powershell", script: "& gh api repos/organicoverlords/rust-v5 --jq '.full_name'", wait_ms: 1_000 });
  assert.equal(native.exit_code, 0, native.stderr);
  assert.equal(shell.exit_code, 0, shell.stderr);
  assert.equal(native.stdout.trim(), "organicoverlords/rust-v5");
  assert.equal(native.stdout.trim(), shell.stdout.trim());
  assert.equal(native.execution_mode, "native");
  assert.equal(shell.execution_mode, "powershell");
  const parser = await complete({ language: "python", script: "def broken(:\n", wait_ms: 1_000 });
  assert.ok(parser.failure_diagnostic, "Rust adapter lost parser diagnostic");
  const rejected = await call("start_process", { executable: "powershell.exe", args: ["-EncodedCommand", "INVALID_FIXTURE_MUST_NOT_EXECUTE"], wait_ms: 0 });
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected), /encoded_command_transport_disallowed/);
  const malformed = await call("start_process", { executable: 123 });
  assert.equal(malformed.isError, true);
  auditProcessRequest("start_process", { executable: "fixture", args: ["authorization=Bearer SECRET_FIXTURE"], stdin: "PRIVATE_STDIN", env: { TOKEN: "PRIVATE_ENV" } });
  await flushProcessAudit();
  const raw = readFileSync(process.env.MCP_PROCESS_AUDIT_PATH, "utf8");
  const events = raw.trim().split("\n").map(JSON.parse);
  assert.ok(events.some(e => e.is_error && e.error?.text.includes("encoded_command_transport_disallowed")));
  assert.ok(events.some(e => e.failure_diagnostic));
  assert.ok(events.some(e => e.command?.text.includes("gh")));
  assert.doesNotMatch(raw, /PRIVATE_STDIN|PRIVATE_ENV|SECRET_FIXTURE/);
  const proof = { result: "PASS", actual_github_read_native_and_shell: true, parser_diagnostic: true,
    encoded_preflight_rejection: true, schema_rejection: true, audit_events: events.length,
    credential_redaction: true, audit_path: process.env.MCP_PROCESS_AUDIT_PATH };
  writeFileSync(join(directory, "proof.json"), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  for (const process_id of owned) await call("kill_process", { process_id });
  await flushProcessAudit();
  await client.close(); await server.close();
}
process.exit(0);
