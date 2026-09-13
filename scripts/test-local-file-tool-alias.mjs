import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

process.env.MCP_TOOL_PROFILE = "process";
process.env.MCP_PROCESS_RECEIPT_DIR = ".state/local-file-tool-alias-receipts";
const { createServer } = await import("../dist/server.js");

process.env.MCP_LOCAL_FILE_TOOL_NAME = "read_local_file";
const aliasServer = createServer("alias-test");
assert.ok(aliasServer._registeredTools.read_local_file, "read_local_file alias must be registered");
assert.equal(aliasServer._registeredTools.upload_local_file, undefined, "alias surface must not expose upload_local_file");
assert.equal(aliasServer._registeredTools.read_local_file.title, "Read local file");
assert.deepEqual(aliasServer._registeredTools.read_local_file.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
assert.equal(aliasServer._registeredTools.read_local_file._meta?.["openai/outputTemplate"], undefined);
assert.equal(aliasServer._registeredTools.read_local_file._meta?.["ui/resourceUri"], undefined);
assert.equal(aliasServer._registeredTools.read_local_file._meta?.ui, undefined);
assert.equal(aliasServer._registeredTools.read_local_file._meta?.["openai/toolInvocation/invoking"], "Reading file…");

delete process.env.MCP_LOCAL_FILE_TOOL_NAME;
const defaultServer = createServer("default-test");
assert.ok(defaultServer._registeredTools.upload_local_file, "default surface must preserve upload_local_file");
assert.equal(defaultServer._registeredTools.read_local_file, undefined, "default surface must not expose read_local_file");

process.env.MCP_LOCAL_FILE_TOOL_NAME = "bogus";
assert.throws(() => createServer("invalid-test"), /MCP_LOCAL_FILE_TOOL_NAME must be one of upload_local_file,read_local_file/);
delete process.env.MCP_LOCAL_FILE_TOOL_NAME;
const aliasVerifier = spawnSync(process.execPath, ["scripts/verify-process-contract.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, MCP_LOCAL_FILE_TOOL_NAME: "read_local_file" },
  encoding: "utf8",
});
assert.equal(aliasVerifier.status, 0, `read_local_file frozen contract verifier must pass: ${aliasVerifier.stderr || aliasVerifier.stdout}`);
assert.match(aliasVerifier.stdout, /tools=.*read_local_file/, "alias verifier must report read_local_file in the frozen tool surface");

console.log("PASS local_file_tool_alias default=upload_local_file isolated=read_local_file widget_free=true read_only=true verifier_alias=true");
