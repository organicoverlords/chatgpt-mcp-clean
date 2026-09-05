import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedJsonlWriter } from "../dist/lib/bounded-jsonl.js";

const root = mkdtempSync(join(tmpdir(), "shell-mcp-bounded-jsonl-"));
const archiveFiles = (path) => {
  const archiveDir = `${path}.archive`;
  if (!existsSync(archiveDir)) return [];
  return readdirSync(archiveDir).map((name) => join(archiveDir, name)).sort();
};
const allSegments = (path) => [...archiveFiles(path), ...(existsSync(path) ? [path] : [])];
const jsonLines = (path) => readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

try {
  const stressPath = join(root, "transport.jsonl");
  const stress = new BoundedJsonlWriter(stressPath, {
    maxBytes: 240,
    maxAgeMs: 60_000,
  });
  for (let sequence = 0; sequence < 60; sequence += 1) {
    stress.writeJson({ event: "stress", sequence, payload: "x".repeat(32) });
  }
  await stress.close();

  const stressSegments = allSegments(stressPath);
  assert.ok(archiveFiles(stressPath).length > 1, "stress run must rotate into immutable archive segments");
  for (const segment of stressSegments) {
    assert.ok(statSync(segment).size <= 240, `${segment} exceeded configured active-segment size`);
  }
  const stressRecords = stressSegments.flatMap(jsonLines).filter((row) => row.event === "stress");
  assert.deepEqual(stressRecords.map((row) => row.sequence).sort((a, b) => a - b), Array.from({ length: 60 }, (_, i) => i), "rotation must preserve every historical record exactly once");

  const preservedArchives = new Map(archiveFiles(stressPath).map((path) => [path, readFileSync(path)]));
  const more = new BoundedJsonlWriter(stressPath, { maxBytes: 180, maxAgeMs: 60_000 });
  for (let sequence = 60; sequence < 90; sequence += 1) more.writeJson({ event: "stress", sequence, payload: "y".repeat(32) });
  await more.close();
  for (const [path, bytes] of preservedArchives) {
    assert.ok(existsSync(path), `historical archive was deleted: ${path}`);
    assert.deepEqual(readFileSync(path), bytes, `historical archive was overwritten: ${path}`);
  }
  const allStressRecords = allSegments(stressPath).flatMap(jsonLines).filter((row) => row.event === "stress");
  assert.deepEqual(allStressRecords.map((row) => row.sequence).sort((a, b) => a - b), Array.from({ length: 90 }, (_, i) => i), "later rotations must preserve all earlier and later records");

  const agedPath = join(root, "aged.jsonl");
  writeFileSync(agedPath, `${JSON.stringify({ event: "before-restart" })}\n`, "utf8");
  const old = new Date(Date.now() - 10_000);
  utimesSync(agedPath, old, old);

  const restarted = new BoundedJsonlWriter(agedPath, {
    maxBytes: 10_000,
    maxAgeMs: 1_000,
  });
  restarted.writeJson({ event: "after-restart" });
  await restarted.close();

  const agedArchives = archiveFiles(agedPath);
  assert.equal(agedArchives.length, 1, `restart-age rotation should archive exactly one prior active segment: ${agedArchives.join(",")}`);
  assert.match(readFileSync(agedArchives[0], "utf8"), /before-restart/);
  assert.doesNotMatch(readFileSync(agedPath, "utf8"), /before-restart/);
  assert.match(readFileSync(agedPath, "utf8"), /after-restart/);

  console.log("PASS bounded JSONL rotates active segments without deleting or overwriting historical telemetry");
} finally {
  rmSync(root, { recursive: true, force: true });
}
