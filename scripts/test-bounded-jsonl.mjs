import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedJsonlWriter } from "../dist/lib/bounded-jsonl.js";

const root = mkdtempSync(join(tmpdir(), "shell-mcp-bounded-jsonl-"));

try {
  const stressPath = join(root, "transport.jsonl");
  const stress = new BoundedJsonlWriter(stressPath, {
    maxBytes: 240,
    maxAgeMs: 60_000,
    maxBackups: 2,
  });
  for (let sequence = 0; sequence < 60; sequence += 1) {
    stress.writeJson({ event: "stress", sequence, payload: "x".repeat(32) });
  }
  await stress.close();

  const stressFiles = readdirSync(root).filter((name) => name.startsWith("transport.jsonl"));
  assert.ok(stressFiles.length <= 3, `backup retention exceeded: ${stressFiles.join(",")}`);
  assert.ok(!existsSync(`${stressPath}.3`), "a third backup must not survive retention");
  for (const name of stressFiles) {
    const size = statSync(join(root, name)).size;
    assert.ok(size <= 240, `${name} exceeded configured size: ${size}`);
  }

  const agedPath = join(root, "aged.jsonl");
  writeFileSync(agedPath, `${JSON.stringify({ event: "before-restart" })}\n`, "utf8");
  const old = new Date(Date.now() - 10_000);
  utimesSync(agedPath, old, old);

  const restarted = new BoundedJsonlWriter(agedPath, {
    maxBytes: 10_000,
    maxAgeMs: 1_000,
    maxBackups: 1,
  });
  restarted.writeJson({ event: "after-restart" });
  await restarted.close();

  assert.match(readFileSync(`${agedPath}.1`, "utf8"), /before-restart/);
  assert.doesNotMatch(readFileSync(agedPath, "utf8"), /before-restart/);
  assert.match(readFileSync(agedPath, "utf8"), /after-restart/);
  console.log("PASS bounded JSONL rotates by size, bounds backup retention, and rotates stale logs after restart");
} finally {
  rmSync(root, { recursive: true, force: true });
}
