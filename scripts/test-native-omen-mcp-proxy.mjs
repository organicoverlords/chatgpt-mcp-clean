import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (process.platform === "win32") { console.log("SKIP native OMEN MCP proxy integration on Windows"); process.exit(0); }

const root = mkdtempSync(join(tmpdir(), "omen-mcp-proxy-"));
const nativePort = 39263;
const edgePort = 39264;
const children = [];
const base = { ...process.env, MCP_TOOL_PROFILE: "process", MCP_BACKEND_MODE: "1", TAILSCALE_OWNER_LOGIN: "owner@example.test", MCP_OWNER_AUTH_MODE: "local-edge", MCP_INTERNAL_LOOPBACK_TRUST: "1", MCP_GHBUF_PROXY_ENABLED: "0" };

function launch(name, port, extra) {
  const state = join(root, name);
  const env = { ...base, PORT: String(port), HOST: "127.0.0.1", MCP_PUBLIC_ORIGIN: `https://${name}.example.test`, MCP_FRONT_DOOR_HOST: `127.0.0.1:${port}`, MCP_OAUTH_STORE_PATH: join(state, "oauth.json"), MCP_PROCESS_RECEIPT_DIR: join(state, "receipts"), MCP_TRANSPORT_LOG_PATH: join(state, "transport.jsonl"), MCP_STALL_LOG_PATH: join(state, "stall.jsonl"), MCP_RUNTIME_INSTANCE_ID: name, MCP_RUNTIME_SOURCE_COMMIT: extra.commit, MCP_RUNTIME_DIST_SHA256: "0".repeat(64), MCP_RUNTIME_SOURCE_DIRTY: "0", MCP_BACKEND_GENERATION: name, ...extra.env };
  const child = spawn(process.execPath, ["dist/index.js"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stderr.on("data", c => process.stderr.write(`[${name}] ${c}`));
  return child;
}

async function waitHealth(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return await r.json(); } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`health timeout ${port}`);
}

const nativeCommit = "a".repeat(40);
const edgeCommit = "b".repeat(40);
launch("native-omen-test", nativePort, { commit: nativeCommit, env: { MCP_DEFAULT_EXECUTION_TARGET: "omen", MCP_NATIVE_OMEN_HOST: "1" } });
await waitHealth(nativePort);
launch("edge-test", edgePort, { commit: edgeCommit, env: { MCP_DEFAULT_EXECUTION_TARGET: "omen", MCP_OMEN_MCP_URL: `http://127.0.0.1:${nativePort}/mcp` } });
await waitHealth(edgePort);

const client = new Client({ name: "native-omen-proxy-test", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${edgePort}/mcp`)));
try {
  const start = await client.callTool({ name: "start_process", arguments: { executable: "hostname", args: [], wait_ms: 10000 } });
  assert.equal(start.isError, undefined, JSON.stringify(start));
  const v = start.structuredContent;
  assert.equal(v.execution_target, "omen");
  assert.equal(v.execution_transport, "native-mcp");
  assert.equal(v.serving_identity.source_commit, edgeCommit);
  assert.equal(v.execution_serving_identity.source_commit, nativeCommit);
  assert.match(v.process_id, /^omen-mcp:/);
  assert.doesNotMatch(String(v.command || ""), /omen_exec|ssh/i);
  assert.ok(String(v.stdout || "").trim());

  const sleeper = (await client.callTool({ name: "start_process", arguments: { executable: "bash", args: ["-lc", "printf READY; sleep 30"], wait_ms: 0 } })).structuredContent;
  assert.match(sleeper.process_id, /^omen-mcp:/);
  const read = (await client.callTool({ name: "read_output", arguments: { process_id: sleeper.process_id, max_chars: 1000, wait_ms: 1000 } })).structuredContent;
  assert.equal(read.execution_transport, "native-mcp");
  assert.match(String(read.stdout || ""), /READY/);
  const killed = (await client.callTool({ name: "kill_process", arguments: { process_id: sleeper.process_id } })).structuredContent;
  assert.equal(killed.execution_transport, "native-mcp");
  assert.equal(killed.killed, true, JSON.stringify(killed));
  console.log(`PASS native_omen_mcp_proxy edge=${edgeCommit.slice(0,7)} execution=${nativeCommit.slice(0,7)} transport=${v.execution_transport}`);
} finally {
  await client.close().catch(() => undefined);
  for (const child of children.reverse()) { try { child.kill("SIGTERM"); } catch {} }
  await new Promise(r => setTimeout(r, 300));
  for (const child of children) { if (!child.killed) { try { child.kill("SIGKILL"); } catch {} } }
  rmSync(root, { recursive: true, force: true });
}
