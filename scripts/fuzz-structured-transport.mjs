import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "../dist/lib/process-manager.js";

const total = Math.max(100, Number(process.env.MCP_TRANSPORT_FUZZ_COUNT || 20000));
const concurrency = Math.max(1, Math.min(24, Number(process.env.MCP_TRANSPORT_FUZZ_CONCURRENCY || 12)));
const seedText = process.env.MCP_TRANSPORT_FUZZ_SEED || "issue324-structured-transport-v1";
let state = Number.parseInt(createHash("sha256").update(seedText).digest("hex").slice(0, 8), 16) >>> 0;
const rnd = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
const pick = (xs, random = rnd) => xs[Math.floor(random() * xs.length)];
function indexedRnd(index) {
  let local = Number.parseInt(createHash("sha256").update(`${seedText}:${index}`).digest("hex").slice(0, 8), 16) >>> 0;
  return () => { local ^= local << 13; local ^= local >>> 17; local ^= local << 5; return (local >>> 0) / 0x100000000; };
}
const specials = ["", " ", "  ", "'", '"', "`", "$", "%", "&", "|", ";", "<", ">", "(", ")", "{", "}", "[", "]", "\\", "/", ":", "=", ",", ".", "?", "*", "!", "#", "@", "^", "~", "\t", "\n", "\r\n", "ä", "ö", "漢", "字", "🙂", "€", "—", "$env:TEMP", "%TEMP%", "C:\\Program Files\\x y", "a;b|c&&d||e", "${x}", "$(x)", "'quoted'", '"quoted"'];
const atoms = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
function randomPayload(maxLen = 320, allowNul = false, random = rnd) {
  let out = "";
  const target = Math.floor(random() * maxLen);
  while (out.length < target) {
    if (random() < 0.28) out += pick(specials, random);
    else out += atoms[Math.floor(random() * atoms.length)];
    if (allowNul && random() < 0.008) out += "\u0000";
  }
  const clipped = out.slice(0, Math.max(0, target));
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}
function sig(value) {
  const b = Buffer.from(value, "utf8");
  return { chars: value.length, bytes: b.length, sha256: createHash("sha256").update(b).digest("hex") };
}
async function settled(manager, result) {
  let current = result;
  for (let i = 0; i < 20 && current?.process_state === "RUNNING"; i += 1) current = await manager.readOutput(current.process_id, 100000, 1000);
  return current;
}

function assertStructuredArgv(result) {
  assert.equal(result.execution_mode, "native", JSON.stringify(result));
  assert.equal(result.execution_reason, "structured_argv", JSON.stringify(result));
}
function assertStructuredScript(result, language) {
  if (language === "powershell") assert.match(String(result.execution_reason || ""), /^structured_script_powershell_stdin/);
  else assert.equal(result.execution_reason, `structured_script_${language}_stdin`, JSON.stringify(result));
}

const scratch = join(tmpdir(), `mcp324-transport-fuzz-${process.pid}`);
mkdirSync(scratch, { recursive: true });
const oracle = join(scratch, "oracle.cjs");
writeFileSync(oracle, `const crypto=require('crypto');\nfunction sig(v){const b=Buffer.from(v,'utf8');return {chars:v.length,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')}}\nconst mode=process.argv[2];\nif(mode==='argv'){process.stdout.write(JSON.stringify(process.argv.slice(3).map(sig)));}\nelse if(mode==='stdin'){const a=[];process.stdin.on('data',x=>a.push(x));process.stdin.on('end',()=>{const b=Buffer.concat(a);process.stdout.write(JSON.stringify({bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')}));});}\nelse if(mode==='env'){process.stdout.write(JSON.stringify(sig(process.env.MCP_FUZZ_PAYLOAD||'')));}\nelse if(mode==='cwd'){process.stdout.write(process.cwd());}\nelse process.exit(97);\n`, "utf8");

const manager = new ProcessManager({ maxLivePerCaller: concurrency + 2, maxCompletedProcesses: 512 });
const failures = [];
let failureCount = 0;
const counts = { argv: 0, stdin: 0, env: 0, cwd: 0, node_script: 0, python_script: 0, powershell_script: 0 };
const durations = [];
const started = performance.now();

async function one(index) {
  const random = indexedRnd(index);
  const bucket = index % 20;
  let kind;
  if (bucket < 7) kind = "argv";
  else if (bucket < 11) kind = "stdin";
  else if (bucket < 14) kind = "env";
  else if (bucket < 15) kind = "cwd";
  else if (bucket < 17) kind = "node_script";
  else if (bucket < 19) kind = "python_script";
  else kind = "powershell_script";
  counts[kind] += 1;
  const t0 = performance.now();
  try {
    if (kind === "argv") {
      const values = Array.from({ length: 1 + Math.floor(random() * 7) }, () => randomPayload(index % 97 === 0 ? 6000 : 700, false, random));
      const r = await settled(manager, await manager.startStructuredWithWait(process.execPath, [oracle, "argv", ...values], process.cwd(), `fuzz_${index}`, 10000));
      assertStructuredArgv(r);
      assert.equal(r.exit_code, 0, JSON.stringify(r));
      assert.deepEqual(JSON.parse(r.stdout), values.map(sig));
    } else if (kind === "stdin") {
      const value = randomPayload(index % 83 === 0 ? 12000 : 2400, true, random);
      const r = await settled(manager, await manager.startStructuredWithWait(process.execPath, [oracle, "stdin"], process.cwd(), `fuzz_${index}`, 10000, undefined, undefined, value));
      assertStructuredArgv(r);
      assert.equal(r.exit_code, 0, JSON.stringify(r));
      const actual = JSON.parse(r.stdout);
      const b = Buffer.from(value, "utf8");
      assert.deepEqual(actual, { bytes: b.length, sha256: createHash("sha256").update(b).digest("hex") });
    } else if (kind === "env") {
      const value = randomPayload(1200, false, random).replaceAll("\u0000", "");
      const r = await settled(manager, await manager.startStructuredWithWait(process.execPath, [oracle, "env"], process.cwd(), `fuzz_${index}`, 10000, undefined, undefined, undefined, { MCP_FUZZ_PAYLOAD: value }));
      assertStructuredArgv(r);
      assert.equal(r.exit_code, 0, JSON.stringify(r));
      assert.deepEqual(JSON.parse(r.stdout), sig(value));
    } else if (kind === "cwd") {
      const dir = join(scratch, `cwd ${index} ä漢`);
      mkdirSync(dir, { recursive: true });
      const r = await settled(manager, await manager.startStructuredWithWait(process.execPath, [oracle, "cwd"], dir, `fuzz_${index}`, 10000));
      assertStructuredArgv(r);
      assert.equal(r.exit_code, 0, JSON.stringify(r));
      assert.equal(r.stdout.toLowerCase(), dir.toLowerCase());
    } else if (kind === "node_script") {
      const value = randomPayload(400, true, random);
      const source = `const v=${JSON.stringify(value)};process.stdout.write(JSON.stringify(v));`;
      const r = await settled(manager, await manager.startScriptWithWait("node", source, process.cwd(), `fuzz_${index}`, 10000));
      assertStructuredScript(r, "node");
      assert.equal(r.exit_code, 0, JSON.stringify(r));
      assert.equal(JSON.parse(r.stdout), value);
    } else if (kind === "python_script") {
      const value = randomPayload(400, true, random);
      const literal = JSON.stringify(value).replace(/\\u2028/gi, "\\u2028").replace(/\\u2029/gi, "\\u2029");
      const source = `import json,sys\nv=${literal}\nsys.stdout.write(json.dumps(v, ensure_ascii=False))\n`;
      const r = await settled(manager, await manager.startScriptWithWait("python", source, process.cwd(), `fuzz_${index}`, 10000));
      assertStructuredScript(r, "python");
      assert.equal(r.exit_code, 0, JSON.stringify(r));
      assert.equal(JSON.parse(r.stdout), value);
    } else {
      const value = randomPayload(280, true, random);
      const literal = value.replaceAll("'", "''");
      const source = `$v='${literal}'; [Console]::Out.Write(($v | ConvertTo-Json -Compress))`;
      const r = await settled(manager, await manager.startScriptWithWait("powershell", source, process.cwd(), `fuzz_${index}`, 10000));
      assertStructuredScript(r, "powershell");
      assert.equal(r.exit_code, 0, JSON.stringify(r));
      assert.equal(JSON.parse(r.stdout), value);
    }
  } catch (error) {
    failureCount += 1;
    if (failures.length < 30) failures.push({ index, kind, error: error instanceof Error ? error.message.slice(0, 5000) : String(error).slice(0, 5000) });
  } finally {
    durations.push(performance.now() - t0);
  }
}

let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (true) {
    const index = next++;
    if (index >= total) break;
    await one(index);
  }
}));

durations.sort((a,b)=>a-b);
const percentile = (p) => durations[Math.min(durations.length - 1, Math.floor(durations.length * p))] ?? 0;
const summary = {
  schema: "structured-transport-fuzz.v1",
  seed: seedText,
  calls: total,
  concurrency,
  counts,
  failures: failureCount,
  failure_rate_pct: Number((100 * failureCount / total).toFixed(5)),
  p50_ms: Number(percentile(0.50).toFixed(2)),
  p95_ms: Number(percentile(0.95).toFixed(2)),
  max_ms: Number((durations.at(-1) ?? 0).toFixed(2)),
  elapsed_s: Number(((performance.now() - started) / 1000).toFixed(2)),
  failure_samples: failures,
};
console.log(JSON.stringify(summary, null, 2));
rmSync(scratch, { recursive: true, force: true });
if (failureCount) process.exit(1);
process.exit(0);
