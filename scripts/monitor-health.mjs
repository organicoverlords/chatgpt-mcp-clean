import { writeFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1]] : null).filter(Boolean));
const origin = String(args.origin || "").replace(/\/$/, "");
const output = String(args.output || "");
const durationMs = Number(args.duration || 8_000);
if (!origin || !output || !Number.isFinite(durationMs) || durationMs < 1_000) throw new Error("--origin, --output, and --duration >= 1000 are required");

const startedAt = new Date().toISOString();
const deadline = Date.now() + durationMs;
const failures = [];
const pids = new Set();
const ports = new Set();
let samples = 0;
let maxLatencyMs = 0;
while (Date.now() < deadline) {
  const sampleStarted = performance.now();
  try {
    const response = await fetch(`${origin}/health`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok || body.status !== "ok" || body.name !== "shell-mcp") failures.push({ at: new Date().toISOString(), status: response.status });
    if (Number.isInteger(body.pid)) pids.add(body.pid);
    if (Number.isInteger(body.port)) ports.add(body.port);
  } catch (error) {
    failures.push({ at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
  }
  samples += 1;
  maxLatencyMs = Math.max(maxLatencyMs, performance.now() - sampleStarted);
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
}
const receipt = { status: failures.length === 0 ? "PROVEN" : "REJECTED", started_at: startedAt, finished_at: new Date().toISOString(), origin, samples, failures, failure_count: failures.length, observed_pids: [...pids], observed_ports: [...ports], max_latency_ms: Number(maxLatencyMs.toFixed(3)) };
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify(receipt));
process.exitCode = failures.length === 0 ? 0 : 1;
