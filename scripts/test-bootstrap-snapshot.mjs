import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { writeFile, rename } from "node:fs/promises";
import { readBootstrapSnapshot, isBootstrapSnapshot } from "../dist/lib/bootstrap-snapshot.js";

async function replaceSnapshot(source, destination) {
  const deadline = Date.now() + 1000;
  for (let delay = 2; ; delay = Math.min(delay * 2, 50)) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (process.platform !== "win32" || error?.code !== "EPERM" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

const root = mkdtempSync(join(tmpdir(), "mcp-bootstrap-snapshot-"));
process.env.MCP_BOOTSTRAP_SNAPSHOT_PATH = join(root, "bootstrap.json");
process.env.MCP_TIMELINE_SNAPSHOT_PATH = join(root, "timeline.json");
process.env.MCP_PROCESS_RECEIPT_DIR = join(root, "receipts");
const realSpawn = childProcess.spawn;
const realExecFile = childProcess.execFile;
childProcess.spawn = childProcess.execFile = () => { throw new Error("Snapshot read must not spawn a process"); };
syncBuiltinESMExports();
function writeBootstrap(overrides = {}) {
  writeFileSync(process.env.MCP_BOOTSTRAP_SNAPSHOT_PATH, JSON.stringify({
    schema: "bootstrap.v1", generated_at: new Date().toISOString(), nonce: randomUUID(),
    bootstrap_end: { status: "COMPLETE", schema: "bootstrap.v1" }, ...overrides,
  }));
}

function writeBootstrapEnvelope(overrides = {}) {
  writeFileSync(process.env.MCP_BOOTSTRAP_SNAPSHOT_PATH, JSON.stringify({
    schema: "bootstrap.v1", generated_at: new Date().toISOString(),
    orientation: {
      conversation: { conversation_context: { messages: [{ text: "message-first-envelope" }] } },
      plumbing: { bootstrap_end: { status: "COMPLETE", schema: "bootstrap.v1" } },
    },
    ...overrides,
  }));
}
try {
  for (const id of ["bootstrap", "231b7e74-4cc8-43d0-9702-fd6dfa2215b3", "timeline", "checkup"]) assert.equal(isBootstrapSnapshot(id), true);
  assert.equal(isBootstrapSnapshot(randomUUID()), false);
  await assert.rejects(readBootstrapSnapshot(), { code: "ENOENT" });
  writeBootstrapEnvelope();
  const envelopeSnapshot = await readBootstrapSnapshot(100_000, "bootstrap", "envelope-caller");
  const envelopePayload = JSON.parse(envelopeSnapshot.stdout);
  assert.equal(envelopePayload.bootstrap_end, undefined);
  assert.equal(envelopePayload.orientation.plumbing.bootstrap_end.status, "COMPLETE");
  assert.equal(envelopePayload.orientation.conversation.conversation_context.messages[0].text, "message-first-envelope");
  writeBootstrapEnvelope({ bootstrap_end: { status: "COMPLETE", schema: "bootstrap.v1" } });
  await assert.rejects(readBootstrapSnapshot(100_000, "bootstrap", "ambiguous-envelope-caller"), /ambiguous bootstrap envelope/);
  writeBootstrap();
  const tinyPage = await readBootstrapSnapshot(1, "bootstrap", "tiny-page-caller");
  assert.equal(tinyPage.next_action, "READ_SAME_PROCESS_ID");
  assert.equal(tinyPage.output_page.page_chars, 1);
  assert.equal(tinyPage.output_page.page_limit, 1);
  const concurrent = await Promise.allSettled(Array.from({ length: 8 }, () => readBootstrapSnapshot()));
  const snapshots = concurrent.map(result => {
    assert.equal(result.status, "fulfilled");
    assert.equal(result.value.mcp_status, "OK");
    assert.equal(result.value.next_action, "STOP_READING");
    return result.value;
  });
  assert.equal(new Set(snapshots.map(result => result.stdout)).size, 1);
  writeBootstrap();
  assert.notEqual((await readBootstrapSnapshot()).stdout, snapshots[0].stdout);
  writeBootstrap({ generated_at: new Date(Date.now() - 100_000).toISOString() });
  assert.equal((await readBootstrapSnapshot()).mcp_status, "STALE");
  for (const invalid of [{ bootstrap_end: null }, { generated_at: "invalid" }, { generated_at: new Date(Date.now() + 60_000).toISOString() }]) {
    writeBootstrap(invalid);
    await assert.rejects(readBootstrapSnapshot(), /incomplete or invalid/);
  }
  writeBootstrap({ schema: "bootstrap.v2", bootstrap_end: { status: "COMPLETE", schema: "bootstrap.v2" }, padding: "x".repeat(90_000) });
  const v2Pieces = [];
  let v2Page = await readBootstrapSnapshot(100_000, "bootstrap", "v2-large-caller");
  assert.equal(v2Page.next_action, "READ_SAME_PROCESS_ID");
  assert.equal(v2Page.output_page.page_limit, 32_000);
  while (true) {
    assert.ok(v2Page.stdout.length <= 32_000, "bootstrap transport page must stay inside the 32k envelope");
    v2Pieces.push(v2Page.stdout);
    if (v2Page.next_action === "STOP_READING") break;
    v2Page = await readBootstrapSnapshot(100_000, "bootstrap", "v2-large-caller");
  }
  const v2Payload = JSON.parse(v2Pieces.join(""));
  assert.equal(v2Payload.schema, "bootstrap.v2");
  assert.equal(v2Payload.bootstrap_end.schema, "bootstrap.v2");
  writeBootstrap({ schema: "bootstrap.v4", bootstrap_end: { status: "COMPLETE", schema: "bootstrap.v4" }, padding: "x".repeat(80_000) });
  const v4Pieces = [];
  let v4Page = await readBootstrapSnapshot(100_000, "bootstrap", "v4-caller");
  while (true) {
    assert.ok(v4Page.stdout.length <= 32_000);
    v4Pieces.push(v4Page.stdout);
    if (v4Page.next_action === "STOP_READING") break;
    v4Page = await readBootstrapSnapshot(100_000, "bootstrap", "v4-caller");
  }
  assert.equal(JSON.parse(v4Pieces.join("")).schema, "bootstrap.v4");
  writeBootstrap({
    schema: "v3-rust.bootstrap.v1",
    coverage: { status: "COMPLETE", exact_user_text: true, age_stripping: false, retained_turns: 300 },
    bootstrap_end: { status: "COMPLETE", schema: "v3-rust.bootstrap.v1" },
  });
  const v3RustPage = await readBootstrapSnapshot(100_000, "bootstrap", "v3-rust-caller");
  assert.equal(JSON.parse(v3RustPage.stdout).schema, "v3-rust.bootstrap.v1");
  writeBootstrap({
    schema: "v3-rust.bootstrap.v1",
    coverage: { status: "PARTIAL", exact_user_text: true, age_stripping: false },
    bootstrap_end: { status: "COMPLETE", schema: "v3-rust.bootstrap.v1" },
  });
  await assert.rejects(readBootstrapSnapshot(100_000, "bootstrap", "v3-rust-partial-caller"), /incomplete or invalid/);
  writeBootstrap({ schema: "bootstrap.v3", bootstrap_end: { status: "COMPLETE", schema: "bootstrap.v3" } });
  await assert.rejects(readBootstrapSnapshot(100_000, "bootstrap", "unknown-schema-caller"), /incomplete or invalid/);
  writeFileSync(process.env.MCP_BOOTSTRAP_SNAPSHOT_PATH, " ".repeat(512 * 1024 + 1));
  await assert.rejects(readBootstrapSnapshot(100_000, "bootstrap", "oversize-v2-caller"), /512 KiB/);
  writeBootstrap();
  const latencies = [];
  for (let batch = 0; batch < 16; batch++) {
    await Promise.all(Array.from({ length: 16 }, async () => {
      const started = performance.now();
      const result = await readBootstrapSnapshot();
      assert.equal(result.mcp_status, "OK");
      latencies.push(performance.now() - started);
    }));
  }
  latencies.sort((a,b) => a-b);
  console.log(JSON.stringify({test:"snapshot concurrency",reads:latencies.length,
    concurrency:16,p50_ms:latencies[127],p95_ms:latencies[243],max_ms:latencies[255]}));
  await Promise.all([
    (async () => {
      for (let version = 0; version < 32; version++) {
        const temporary = process.env.MCP_BOOTSTRAP_SNAPSHOT_PATH + '.next';
        await writeFile(temporary, JSON.stringify({ schema:"bootstrap.v1", generated_at:new Date().toISOString(),
          version, padding:'x'.repeat(12000), bootstrap_end:{status:"COMPLETE",schema:"bootstrap.v1"} }));
        await replaceSnapshot(temporary, process.env.MCP_BOOTSTRAP_SNAPSHOT_PATH);
      }
    })(),
    ...Array.from({length:8}, async () => {
      for (let iteration = 0; iteration < 32; iteration++) {
        const snapshot = await readBootstrapSnapshot();
        assert.equal(snapshot.mcp_status,"OK");
        assert.equal(JSON.parse(snapshot.stdout).bootstrap_end.status,"COMPLETE");
      }
    }),
  ]);
  console.log('PASS atomic publisher replacement during 256 concurrent reads');

  writeBootstrap({ marker: "stable-pages", padding: "x".repeat(90_000) });
  const pagePieces = [];
  let paged = await readBootstrapSnapshot(32_000, "bootstrap", "paging-stability-caller");
  assert.equal(paged.next_action, "READ_SAME_PROCESS_ID");
  assert.equal(paged.output_page.page_limit, 32_000);
  assert.ok(paged.stdout.length <= 32_000);
  const modelVisiblePage = {
    content: [],
    structuredContent: {
      ...paged,
      caller_id: "caller_paging_regression",
      serving_identity: {
        tool_contract_version: "process-tools.v4",
        backend_generation: "backend-paging-regression",
        source_commit: "a".repeat(40),
      },
    },
  };
  assert.ok(JSON.stringify(modelVisiblePage).length < 64_000, "forced 32k bootstrap page must stay inside the proven MCP response envelope");
  const expectedTotal = paged.output_page.stdout_total;
  pagePieces.push(paged.stdout);
  writeBootstrap({ marker: "replacement-after-first-page", padding: "y".repeat(90_000) });
  while (paged.next_action === "READ_SAME_PROCESS_ID") {
    paged = await readBootstrapSnapshot(32_000, "bootstrap", "paging-stability-caller");
    assert.ok(paged.stdout.length <= 32_000);
    pagePieces.push(paged.stdout);
  }
  const reconstructed = pagePieces.join("");
  assert.equal(reconstructed.length, expectedTotal);
  assert.equal(JSON.parse(reconstructed).marker, "stable-pages");
  assert.ok(pagePieces.length >= 2);

  const replacementPieces = [];
  let replacement = await readBootstrapSnapshot(32_000, "bootstrap", "paging-stability-caller");
  while (true) {
    replacementPieces.push(replacement.stdout);
    if (replacement.next_action === "STOP_READING") break;
    replacement = await readBootstrapSnapshot(32_000, "bootstrap", "paging-stability-caller");
  }
  assert.equal(JSON.parse(replacementPieces.join("")).marker, "replacement-after-first-page");
  console.log("PASS lossless bootstrap paging stays snapshot-stable across producer refresh");
  writeFileSync(process.env.MCP_TIMELINE_SNAPSHOT_PATH, JSON.stringify({
    schema: "vault.timeline.bootstrap.v1", generated_at: new Date(Date.now() - 1000_000).toISOString(),
    overview: { timeline_materialized: { status: "FRESH", refresh_minutes: 5, coverage_status: "HISTORICAL_INCOMPLETE" } },
  }));
  const timeline = await readBootstrapSnapshot(32000, "timeline");
  assert.equal(timeline.mcp_status, "STALE");
  const meta = JSON.parse(timeline.stdout).overview.timeline_materialized;
  assert.equal(meta.status, "STALE");
  assert.equal(meta.coverage_status, "HISTORICAL_INCOMPLETE");
  assert.equal(meta.absence_semantics, "NO_MATCH_IS_NOT_PROOF_OF_ABSENCE");

  const { createServer } = await import("../dist/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createServer("bootstrap-regression-test");
  const client = new Client({ name: "bootstrap-regression-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const id of ["231b7e74-4cc8-43d0-9702-fd6dfa2215b3", "bootstrap", "timeline", "checkup"]) {
      const started = performance.now();
      const reply = await client.callTool({ name: "read_output", arguments: { process_id: id, max_chars: 100000, wait_ms: 0 } });
      assert.equal(reply.isError, undefined, JSON.stringify(reply));
      assert.equal(reply.structuredContent.snapshot_alias, true);
      console.log(`PASS local MCP read_output ${id}: ${Math.round(performance.now() - started)} ms, no subprocess`);
    }
  } finally { await client.close(); await server.close(); }
  console.log("PASS materialized reads: concurrency, size limits, freshness, missing/invalid files, failure recovery");
} finally {
  childProcess.spawn = realSpawn;
  childProcess.execFile = realExecFile;
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
}
