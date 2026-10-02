import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
process.env.MCP_SHARED_RULES_PATH = join(root, "BOOTSTRAP_RULES.md");
process.env.MCP_SHARED_AGENTS_PATH = join(root, "AGENTS.md");
process.env.MCP_SHARED_CONTRACTS_PATH = join(root, "CONTRACTS.json");
process.env.MCP_SHARED_ROUTES_PATH = join(root, "ROUTES.json");
writeFileSync(process.env.MCP_SHARED_RULES_PATH, "RULES_BEGIN\n" + "r".repeat(35_000) + "\nRULES_END\n");
writeFileSync(process.env.MCP_SHARED_AGENTS_PATH, "# Agents\nagent-contract\n");
writeFileSync(process.env.MCP_SHARED_CONTRACTS_PATH, '{"contracts":["owner"]}\n');
writeFileSync(process.env.MCP_SHARED_ROUTES_PATH, '{"routes":["bootstrap"]}\n');
process.env.MCP_V3_BOOTSTRAP_EXECUTABLE = process.execPath;
process.env.MCP_V3_BOOTSTRAP_CWD = root;
writeFileSync(join(root, "bootstrap"), [
  'const args = process.argv.slice(2);',
  'const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };',
  'const conversationId = value("--conversation-id");',
  'const roomHead = value("--expected-room-head");',
  'if (!conversationId || !roomHead) { console.error("missing room identity"); process.exit(2); }',
  'const paged = conversationId.includes("paged-");',
  'const payload = {',
  '  schema: "v3-rust.bootstrap.v1",',
  '  generated_at: new Date().toISOString(),',
  '  conversation: { current_conversation_id: conversationId, chats: [{ current: true, id: conversationId, messages: [] }] },',
  '  coverage: { status: "WINDOWED", exact_user_text: true, user_message_age_stripping: false, retained_turns: 400 },',
  '  source: { coverage_status: "COMPLETE", exact_user_text: true, user_message_age_stripping: false },',
  '  bootstrap_end: { status: "COMPLETE", schema: "v3-rust.bootstrap.v1" },',
  '  proof_expected_room_head: roomHead,',
  '  ...(paged ? { padding: "x".repeat(300000) } : {}),',
  '};',
  'process.stdout.write(JSON.stringify(payload));',
].join("\n"));
const realSpawn = childProcess.spawn;
const realExecFile = childProcess.execFile;
childProcess.spawn = childProcess.execFile = () => { throw new Error("Snapshot read must not spawn a process"); };
syncBuiltinESMExports();
async function withRealExecFile(fn) {
  childProcess.execFile = realExecFile;
  syncBuiltinESMExports();
  try { return await fn(); }
  finally {
    childProcess.execFile = () => { throw new Error("Snapshot read must not spawn a process"); };
    syncBuiltinESMExports();
  }
}
function writeBootstrap(overrides = {}) {
  writeFileSync(process.env.MCP_BOOTSTRAP_SNAPSHOT_PATH, JSON.stringify({
    schema: "bootstrap.v1", generated_at: new Date().toISOString(), nonce: randomUUID(),
    bootstrap_end: { status: "COMPLETE", schema: "bootstrap.v1" }, ...overrides,
  }));
}

function callerBootstrapPath(callerId) {
  const hash = createHash("sha256")
    .update("v3-rust.bootstrap-caller.v1\0", "utf8")
    .update(callerId.trim(), "utf8")
    .digest("hex");
  return join(root, "callers", hash + ".json");
}

function writeCallerBootstrap(callerId, overrides = {}) {
  const path = callerBootstrapPath(callerId);
  const directory = join(root, "callers");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, JSON.stringify({
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
  for (const id of ["bootstrap", "231b7e74-4cc8-43d0-9702-fd6dfa2215b3", "timeline", "checkup", "rules", "agents", "contracts", "routes"]) assert.equal(isBootstrapSnapshot(id), true);
  assert.equal(isBootstrapSnapshot(randomUUID()), false);

  const rulePieces = [];
  let rulePage = await readBootstrapSnapshot(30_000, "rules", "policy-caller");
  while (true) {
    assert.equal(rulePage.shared_policy_alias, true);
    assert.deepEqual(rulePage.sources, ["BOOTSTRAP_RULES.md"]);
    rulePieces.push(rulePage.stdout);
    if (rulePage.next_action === "STOP_READING") break;
    rulePage = await readBootstrapSnapshot(30_000, "rules", "policy-caller");
  }
  assert.match(rulePieces.join(""), /^RULES_BEGIN\n/);
  assert.match(rulePieces.join(""), /RULES_END\n$/);
  assert.equal((await readBootstrapSnapshot(30_000, "agents", "agents-caller")).stdout, "# Agents\nagent-contract\n");
  assert.equal((await readBootstrapSnapshot(30_000, "contracts", "contracts-caller")).stdout, '{"contracts":["owner"]}\n');
  assert.equal((await readBootstrapSnapshot(30_000, "routes", "routes-caller")).stdout, '{"routes":["bootstrap"]}\n');

  await assert.rejects(readBootstrapSnapshot(), { code: "ENOENT" });
  writeBootstrapEnvelope();
  const envelopeSnapshot = await readBootstrapSnapshot(100_000, "bootstrap", "envelope-caller");
  const envelopePayload = JSON.parse(envelopeSnapshot.stdout);
  assert.equal(envelopePayload.bootstrap_end, undefined);
  assert.equal(envelopePayload.orientation.plumbing.bootstrap_end.status, "COMPLETE");
  assert.equal(envelopePayload.orientation.conversation.conversation_context.messages[0].text, "message-first-envelope");
  writeBootstrapEnvelope({ bootstrap_end: { status: "COMPLETE", schema: "bootstrap.v1" } });
  await assert.rejects(readBootstrapSnapshot(100_000, "bootstrap", "ambiguous-envelope-caller"), /ambiguous bootstrap envelope/);
  writeBootstrap({ marker: "global-fallback" });
  writeCallerBootstrap("caller-scoped", { marker: "caller-scoped" });
  const callerScoped = await readBootstrapSnapshot(100_000, "bootstrap", "caller-scoped");
  assert.equal(JSON.parse(callerScoped.stdout).marker, "caller-scoped");
  const callerFallback = await readBootstrapSnapshot(100_000, "bootstrap", "caller-without-snapshot");
  assert.equal(JSON.parse(callerFallback.stdout).marker, "global-fallback");

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
  const structuralRules = `RULES_BEGIN\n${"r".repeat(17_000)}\nRULES_END`;
  const structuralContract = `CONTRACT_BEGIN\n${"c".repeat(12_000)}\nCONTRACT_END`;
  writeBootstrap({
    padding_before_rules: "p".repeat(22_000),
    rules: structuralRules,
    lifecycle_contract: structuralContract,
    tail_after_contract: "t".repeat(25_000),
  });
  const structuralPieces = [];
  let structuralPage = await readBootstrapSnapshot(30_000, "bootstrap", "structural-boundary-caller");
  while (true) {
    assert.ok(structuralPage.stdout.length <= 30_000);
    structuralPieces.push(structuralPage.stdout);
    if (structuralPage.next_action === "STOP_READING") break;
    structuralPage = await readBootstrapSnapshot(30_000, "bootstrap", "structural-boundary-caller");
  }
  assert.equal(structuralPieces.filter(piece => piece.includes("RULES_BEGIN") && piece.includes("RULES_END")).length, 1, "rules must stay whole on one model-visible snapshot page");
  assert.equal(structuralPieces.some(piece => piece.includes("RULES_BEGIN") !== piece.includes("RULES_END")), false, "rules must not be split across snapshot pages");
  assert.equal(structuralPieces.filter(piece => piece.includes("CONTRACT_BEGIN") && piece.includes("CONTRACT_END")).length, 1, "contract must stay whole on one model-visible snapshot page");
  assert.equal(structuralPieces.some(piece => piece.includes("CONTRACT_BEGIN") !== piece.includes("CONTRACT_END")), false, "contract must not be split across snapshot pages");
  const reconstructedStructural = structuralPieces.join("");
  const parsedStructural = JSON.parse(reconstructedStructural);
  assert.equal(parsedStructural.rules, structuralRules);
  assert.equal(parsedStructural.lifecycle_contract, structuralContract);

  writeBootstrap({ schema: "bootstrap.v2", bootstrap_end: { status: "COMPLETE", schema: "bootstrap.v2" }, padding: "x".repeat(300_000) });
  const v2Pieces = [];
  let v2Page = await readBootstrapSnapshot(1_000_000, "bootstrap", "v2-large-caller");
  assert.equal(v2Page.next_action, "READ_SAME_PROCESS_ID");
  assert.equal(v2Page.output_page.page_limit, 30_000);
  while (true) {
    assert.ok(v2Page.stdout.length <= 30_000, "bootstrap model-facing page must stay inside the 30k envelope");
    v2Pieces.push(v2Page.stdout);
    if (v2Page.next_action === "STOP_READING") break;
    v2Page = await readBootstrapSnapshot(1_000_000, "bootstrap", "v2-large-caller");
  }
  const v2Payload = JSON.parse(v2Pieces.join(""));
  assert.equal(v2Payload.schema, "bootstrap.v2");
  assert.equal(v2Payload.bootstrap_end.schema, "bootstrap.v2");
  assert.match(v2Pieces.join(""), /\n  "schema": "bootstrap\.v2"/, "bootstrap output remains readable JSON");
  writeBootstrap({ schema: "bootstrap.v4", bootstrap_end: { status: "COMPLETE", schema: "bootstrap.v4" }, padding: "x".repeat(280_000) });
  const v4Pieces = [];
  let v4Page = await readBootstrapSnapshot(1_000_000, "bootstrap", "v4-caller");
  while (true) {
    assert.ok(v4Page.stdout.length <= 30_000);
    v4Pieces.push(v4Page.stdout);
    if (v4Page.next_action === "STOP_READING") break;
    v4Page = await readBootstrapSnapshot(1_000_000, "bootstrap", "v4-caller");
  }
  assert.equal(JSON.parse(v4Pieces.join("")).schema, "bootstrap.v4");
  writeBootstrap({
    schema: "v3-rust.bootstrap.v1",
    coverage: { status: "COMPLETE", exact_user_text: true, age_stripping: false, retained_turns: 300 },
    bootstrap_end: { status: "COMPLETE", schema: "v3-rust.bootstrap.v1" },
  });
  const v3RustPage = await readBootstrapSnapshot(256_000, "bootstrap", "v3-rust-caller");
  assert.equal(JSON.parse(v3RustPage.stdout).schema, "v3-rust.bootstrap.v1");
  writeBootstrap({
    schema: "v3-rust.bootstrap.v1",
    source: { coverage_status: "COMPLETE", exact_user_text: true, user_message_age_stripping: false },
    coverage: { status: "WINDOWED", exact_user_text: true, user_message_age_stripping: false, retained_turns: 400 },
    bootstrap_end: { status: "COMPLETE", schema: "v3-rust.bootstrap.v1" },
  });
  const v3WindowedPage = await readBootstrapSnapshot(256_000, "bootstrap", "v3-rust-windowed-caller");
  const v3WindowedPayload = JSON.parse(v3WindowedPage.stdout);
  assert.equal(v3WindowedPayload.coverage.status, "WINDOWED");
  assert.equal(v3WindowedPayload.coverage.retained_turns, 400);

  await withRealExecFile(async () => {
    const room = await readBootstrapSnapshot(256_000, "bootstrap", "room-caller", "local-chat:alpha", "turn-alpha");
    const roomPayload = JSON.parse(room.stdout);
    assert.equal(room.freshness.read_mode, "V3_ROOM_BOUND_READ");
    assert.equal(roomPayload.conversation.current_conversation_id, "local-chat:alpha");
    assert.equal(roomPayload.conversation.chats[0].current, true);
    assert.equal(roomPayload.proof_expected_room_head, "turn-alpha");

    await assert.rejects(
      readBootstrapSnapshot(256_000, "bootstrap", "room-missing-head", "local-chat:alpha"),
      /requires both conversation_id and expected_room_head/,
    );

    const alphaPieces = [];
    const betaPieces = [];
    let alpha = await readBootstrapSnapshot(160_000, "bootstrap", "same-caller", "local-chat:paged-alpha", "turn-alpha");
    let beta = await readBootstrapSnapshot(160_000, "bootstrap", "same-caller", "local-chat:paged-beta", "turn-beta");
    assert.equal(alpha.next_action, "READ_SAME_PROCESS_ID");
    assert.equal(beta.next_action, "READ_SAME_PROCESS_ID");
    while (true) {
      alphaPieces.push(alpha.stdout);
      if (alpha.next_action === "STOP_READING") break;
      alpha = await readBootstrapSnapshot(160_000, "bootstrap", "same-caller", "local-chat:paged-alpha", "turn-alpha");
    }
    while (true) {
      betaPieces.push(beta.stdout);
      if (beta.next_action === "STOP_READING") break;
      beta = await readBootstrapSnapshot(160_000, "bootstrap", "same-caller", "local-chat:paged-beta", "turn-beta");
    }
    const alphaPayload = JSON.parse(alphaPieces.join(""));
    const betaPayload = JSON.parse(betaPieces.join(""));
    assert.equal(alphaPayload.conversation.current_conversation_id, "local-chat:paged-alpha");
    assert.equal(alphaPayload.proof_expected_room_head, "turn-alpha");
    assert.equal(betaPayload.conversation.current_conversation_id, "local-chat:paged-beta");
    assert.equal(betaPayload.proof_expected_room_head, "turn-beta");
  });

  writeBootstrap({
    schema: "v3-rust.bootstrap.v1",
    coverage: { status: "PARTIAL", exact_user_text: true, age_stripping: false },
    bootstrap_end: { status: "COMPLETE", schema: "v3-rust.bootstrap.v1" },
  });
  await assert.rejects(readBootstrapSnapshot(256_000, "bootstrap", "v3-rust-partial-caller"), /incomplete or invalid/);
  writeBootstrap({ schema: "bootstrap.v3", bootstrap_end: { status: "COMPLETE", schema: "bootstrap.v3" } });
  await assert.rejects(readBootstrapSnapshot(256_000, "bootstrap", "unknown-schema-caller"), /incomplete or invalid/);
  writeBootstrap({ marker: "over-512k-readable", padding: "z".repeat(700_000) });
  const hugePieces = [];
  let hugePage = await readBootstrapSnapshot(1_000_000, "bootstrap", "large-bootstrap-caller");
  while (true) {
    assert.ok(hugePage.stdout.length <= 30_000);
    hugePieces.push(hugePage.stdout);
    if (hugePage.next_action === "STOP_READING") break;
    hugePage = await readBootstrapSnapshot(1_000_000, "bootstrap", "large-bootstrap-caller");
  }
  const hugeText = hugePieces.join("");
  assert.match(hugeText, /\n  "schema": "bootstrap\.v1"/, "bootstrap output must remain human-readable JSON");
  assert.equal(JSON.parse(hugeText).marker, "over-512k-readable");
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

  writeBootstrap({ marker: "stable-pages", padding: "x".repeat(400_000) });
  const pagePieces = [];
  let paged = await readBootstrapSnapshot(256_000, "bootstrap", "paging-stability-caller");
  assert.equal(paged.next_action, "READ_SAME_PROCESS_ID");
  assert.equal(paged.output_page.page_limit, 30_000);
  assert.ok(paged.stdout.length <= 30_000);
  const modelVisiblePage = {
    content: [],
    structuredContent: {
      ...paged,
      caller_id: "caller_paging_regression",
      serving_identity: {
        tool_contract_version: "process-tools.v6",
        backend_generation: "backend-paging-regression",
        source_commit: "a".repeat(40),
      },
    },
  };
  assert.ok(JSON.stringify(modelVisiblePage).length < 40_000, "30k bootstrap page plus response metadata stays model-visible");
  const expectedTotal = paged.output_page.stdout_total;
  pagePieces.push(paged.stdout);
  writeBootstrap({ marker: "replacement-after-first-page", padding: "y".repeat(400_000) });
  while (paged.next_action === "READ_SAME_PROCESS_ID") {
    paged = await readBootstrapSnapshot(256_000, "bootstrap", "paging-stability-caller");
    assert.ok(paged.stdout.length <= 30_000);
    pagePieces.push(paged.stdout);
  }
  const reconstructed = pagePieces.join("");
  assert.equal(reconstructed.length, expectedTotal);
  assert.equal(JSON.parse(reconstructed).marker, "stable-pages");
  assert.ok(pagePieces.length >= 2);

  const replacementPieces = [];
  let replacement = await readBootstrapSnapshot(256_000, "bootstrap", "paging-stability-caller");
  while (true) {
    replacementPieces.push(replacement.stdout);
    if (replacement.next_action === "STOP_READING") break;
    replacement = await readBootstrapSnapshot(256_000, "bootstrap", "paging-stability-caller");
  }
  assert.equal(JSON.parse(replacementPieces.join("")).marker, "replacement-after-first-page");
  console.log("PASS lossless bootstrap paging stays snapshot-stable across producer refresh");
  writeFileSync(process.env.MCP_TIMELINE_SNAPSHOT_PATH, JSON.stringify({
    schema: "vault.timeline.bootstrap.v1", generated_at: new Date(Date.now() - 1000_000).toISOString(),
    overview: { timeline_materialized: { status: "FRESH", refresh_minutes: 5, coverage_status: "HISTORICAL_INCOMPLETE" } },
  }));
  const timeline = await readBootstrapSnapshot(256000, "timeline");
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
    await withRealExecFile(async () => {
      const roomReply = await client.callTool({
        name: "read_output",
        arguments: {
          process_id: "bootstrap",
          conversation_id: "local-chat:tool-room",
          expected_room_head: "turn-tool-room",
          max_chars: 256000,
          wait_ms: 0,
        },
      });
      assert.equal(roomReply.isError, undefined, JSON.stringify(roomReply));
      assert.equal(roomReply.structuredContent.bootstrap_alias, true);
      assert.equal(roomReply.structuredContent.freshness.read_mode, "V3_ROOM_BOUND_READ");
      const roomPayload = JSON.parse(roomReply.structuredContent.stdout);
      assert.equal(roomPayload.conversation.current_conversation_id, "local-chat:tool-room");
      assert.equal(roomPayload.proof_expected_room_head, "turn-tool-room");
    });

    for (const id of ["231b7e74-4cc8-43d0-9702-fd6dfa2215b3", "bootstrap", "timeline", "checkup", "rules", "agents", "contracts", "routes"]) {
      const started = performance.now();
      const reply = await client.callTool({ name: "read_output", arguments: { process_id: id, max_chars: 30000, wait_ms: 0 } });
      assert.equal(reply.isError, undefined, JSON.stringify(reply));
      assert.equal(reply.structuredContent.snapshot_alias, true);
      if (["rules", "agents", "contracts", "routes"].includes(id)) {
        assert.equal(reply.structuredContent.shared_policy_alias, true);
      }
      console.log("PASS local MCP read_output " + id + ": " + Math.round(performance.now() - started) + " ms, no subprocess");
    }
  } finally { await client.close(); await server.close(); }
  console.log("PASS materialized reads: concurrency, 30k model-visible paging, readable large bootstrap, freshness, missing/invalid files, failure recovery");
} finally {
  childProcess.spawn = realSpawn;
  childProcess.execFile = realExecFile;
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
}
