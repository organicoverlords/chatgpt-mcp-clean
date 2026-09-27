import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readBootstrapSnapshot, isBootstrapSnapshot } from "../dist/lib/bootstrap-snapshot.js";

const root = mkdtempSync(join(tmpdir(), "mcp-bootstrap-v3-"));
const payloadPath = join(root, "bootstrap.json");
const staleLegacyPath = join(root, "legacy-bootstrap.json");
process.env.MCP_BOOTSTRAP_SNAPSHOT_PATH = staleLegacyPath;
process.env.MCP_TIMELINE_SNAPSHOT_PATH = join(root, "timeline.json");
process.env.MCP_PROCESS_RECEIPT_DIR = join(root, "receipts");
process.env.MCP_V3_BOOTSTRAP_EXECUTABLE = process.execPath;
process.env.MCP_V3_BOOTSTRAP_CWD = root;
process.env.FAKE_V3_BOOTSTRAP_PAYLOAD = payloadPath;

writeFileSync(join(root, "bootstrap"), [
  'const fs = require("node:fs");',
  'const path = process.env.FAKE_V3_BOOTSTRAP_PAYLOAD;',
  'if (!path) throw new Error("missing FAKE_V3_BOOTSTRAP_PAYLOAD");',
  'process.stdout.write(fs.readFileSync(path, "utf8"));',
].join("\n"));

writeFileSync(staleLegacyPath, JSON.stringify({
  schema: "bootstrap.v2",
  generated_at: new Date().toISOString(),
  bootstrap_end: { status: "COMPLETE", schema: "bootstrap.v2" },
  marker: "must-never-be-read",
}));

function writeBootstrap(overrides = {}) {
  const base = {
    schema: "v3-rust.bootstrap.v1",
    generated_at: new Date().toISOString(),
    coverage: {
      status: "COMPLETE",
      exact_user_text: true,
      user_message_age_stripping: false,
      retained_turns: 400,
      selection_scope: "400 newest retained exact user messages from the V3 message spine",
    },
    bootstrap_end: { status: "COMPLETE", schema: "v3-rust.bootstrap.v1" },
    marker: randomUUID(),
  };
  writeFileSync(payloadPath, JSON.stringify({ ...base, ...overrides }));
}

async function readAll(callerId, maxChars = 256_000) {
  const pieces = [];
  let page = await readBootstrapSnapshot(maxChars, "bootstrap", callerId);
  while (true) {
    pieces.push(page.stdout);
    if (page.next_action === "STOP_READING") return { page, text: pieces.join("") };
    page = await readBootstrapSnapshot(maxChars, "bootstrap", callerId);
  }
}

try {
  for (const id of ["bootstrap", "231b7e74-4cc8-43d0-9702-fd6dfa2215b3", "timeline", "checkup"]) {
    assert.equal(isBootstrapSnapshot(id), true);
  }
  assert.equal(isBootstrapSnapshot(randomUUID()), false);

  writeBootstrap({ marker: "current-v3" });
  const first = await readBootstrapSnapshot(256_000, "bootstrap", "first-caller");
  assert.equal(first.bootstrap_alias, true);
  assert.equal(first.snapshot_alias, true);
  assert.equal(first.freshness.read_mode, "V3_DIRECT_READ");
  assert.equal(JSON.parse(first.stdout).schema, "v3-rust.bootstrap.v1");
  assert.equal(JSON.parse(first.stdout).marker, "current-v3");
  assert.doesNotMatch(first.stdout, /must-never-be-read/);

  const legacyId = await readBootstrapSnapshot(256_000, "231b7e74-4cc8-43d0-9702-fd6dfa2215b3", "legacy-id-caller");
  assert.equal(JSON.parse(legacyId.stdout).schema, "v3-rust.bootstrap.v1");

  writeBootstrap({
    schema: "bootstrap.v2",
    bootstrap_end: { status: "COMPLETE", schema: "bootstrap.v2" },
  });
  await assert.rejects(
    readBootstrapSnapshot(256_000, "bootstrap", "reject-v2"),
    /incomplete or invalid/,
  );

  writeBootstrap({
    coverage: {
      status: "PARTIAL",
      exact_user_text: true,
      user_message_age_stripping: false,
      retained_turns: 399,
    },
  });
  await assert.rejects(
    readBootstrapSnapshot(256_000, "bootstrap", "reject-partial"),
    /incomplete or invalid/,
  );

  writeBootstrap({ marker: "tiny-page", padding: "x".repeat(5000) });
  const tiny = await readBootstrapSnapshot(1, "bootstrap", "tiny-page-caller");
  assert.equal(tiny.next_action, "READ_SAME_PROCESS_ID");
  assert.equal(tiny.output_page.page_chars, 1);
  assert.equal(tiny.output_page.page_limit, 1);

  writeBootstrap({ marker: "stable-pages", padding: "x".repeat(400_000) });
  const firstPage = await readBootstrapSnapshot(256_000, "bootstrap", "paging-caller");
  assert.equal(firstPage.next_action, "READ_SAME_PROCESS_ID");
  const expectedTotal = firstPage.output_page.stdout_total;
  const pieces = [firstPage.stdout];

  writeBootstrap({ marker: "replacement-after-page-one", padding: "y".repeat(400_000) });
  let page = firstPage;
  while (page.next_action === "READ_SAME_PROCESS_ID") {
    page = await readBootstrapSnapshot(256_000, "bootstrap", "paging-caller");
    pieces.push(page.stdout);
  }
  const stableText = pieces.join("");
  assert.equal(stableText.length, expectedTotal);
  assert.equal(JSON.parse(stableText).marker, "stable-pages");

  const replacement = await readAll("paging-caller");
  assert.equal(JSON.parse(replacement.text).marker, "replacement-after-page-one");

  writeBootstrap({ marker: "concurrent" });
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, (_, index) => readBootstrapSnapshot(256_000, "bootstrap", "concurrent-" + index)),
  );
  for (const result of concurrent) {
    assert.equal(result.mcp_status, "OK");
    assert.equal(result.next_action, "STOP_READING");
    assert.equal(JSON.parse(result.stdout).marker, "concurrent");
  }

  writeFileSync(process.env.MCP_TIMELINE_SNAPSHOT_PATH, JSON.stringify({
    schema: "vault.timeline.bootstrap.v1",
    generated_at: new Date(Date.now() - 1_000_000).toISOString(),
    overview: {
      timeline_materialized: {
        status: "FRESH",
        refresh_minutes: 5,
        coverage_status: "HISTORICAL_INCOMPLETE",
      },
    },
  }));
  const timeline = await readBootstrapSnapshot(256_000, "timeline", "timeline-caller");
  assert.equal(timeline.freshness.read_mode, "MATERIALIZED_ONLY");
  assert.equal(timeline.mcp_status, "STALE");
  const timelinePayload = JSON.parse(timeline.stdout);
  assert.equal(timelinePayload.overview.timeline_materialized.coverage_status, "HISTORICAL_INCOMPLETE");
  assert.equal(timelinePayload.overview.timeline_materialized.absence_semantics, "NO_MATCH_IS_NOT_PROOF_OF_ABSENCE");

  writeBootstrap({ marker: "server-v3" });
  const { createServer } = await import("../dist/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createServer("bootstrap-regression-test");
  const client = new Client({ name: "bootstrap-regression-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const reply = await client.callTool({
      name: "read_output",
      arguments: { process_id: "bootstrap", max_chars: 256000, wait_ms: 0 },
    });
    assert.equal(reply.isError, undefined, JSON.stringify(reply));
    assert.equal(reply.structuredContent.bootstrap_alias, true);
    assert.equal(reply.structuredContent.freshness.read_mode, "V3_DIRECT_READ");
    assert.equal(JSON.parse(reply.structuredContent.stdout).schema, "v3-rust.bootstrap.v1");
    assert.equal(JSON.parse(reply.structuredContent.stdout).marker, "server-v3");
  } finally {
    await client.close();
    await server.close();
  }

  console.log("PASS bootstrap alias delegates to current V3 producer, rejects legacy schemas, and pages losslessly");
} finally {
  rmSync(root, { recursive: true, force: true });
}
