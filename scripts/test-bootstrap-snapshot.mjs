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
try {
  for (const id of ["bootstrap", "231b7e74-4cc8-43d0-9702-fd6dfa2215b3", "timeline", "checkup"]) assert.equal(isBootstrapSnapshot(id), true);
  assert.equal(isBootstrapSnapshot(randomUUID()), false);
  await assert.rejects(readBootstrapSnapshot(), { code: "ENOENT" });
  writeBootstrap();
  const concurrent = await Promise.allSettled([readBootstrapSnapshot(1), ...Array.from({ length: 8 }, () => readBootstrapSnapshot())]);
  assert.equal(concurrent[0].status, "rejected");
  const snapshots = concurrent.slice(1).map(result => {
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
  writeFileSync(process.env.MCP_BOOTSTRAP_SNAPSHOT_PATH, " ".repeat(65537));
  await assert.rejects(readBootstrapSnapshot(), /64 KiB/);
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
      const reply = await client.callTool({ name: "read_output", arguments: { process_id: id, max_chars: 32000, wait_ms: 0 } });
      assert.equal(reply.isError, undefined, JSON.stringify(reply));
      assert.equal(JSON.parse(reply.content[0].text).snapshot_alias, true);
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
