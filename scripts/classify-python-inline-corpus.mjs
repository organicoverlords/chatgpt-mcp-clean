import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { planCommandExecution } from "../dist/lib/command-execution-plan.js";
import { replayFailureDiagnostic } from "../dist/lib/process-manager.js";

const root = process.env.MCP_REPLAY_ROOT || join(process.env.LOCALAPPDATA || "", "ChatGPTMcpClean", "minimal-connectors", "shared-process-receipts");
const archive = join(root, "archive");
const pwsh = process.env.MCP_POWERSHELL_EXE || "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const concurrency = Math.max(1, Math.min(64, Number(process.env.MCP_PYTHON_SCAN_CONCURRENCY || 24)));

async function collectFiles() {
  const files = new Map();
  const dirs = [{ path: root, rank: 2 }];
  if (existsSync(archive)) for (const entry of await readdir(archive, { withFileTypes: true })) if (entry.isDirectory()) dirs.push({ path: join(archive, entry.name), rank: 1 });
  for (const dir of dirs) {
    if (!existsSync(dir.path)) continue;
    for (const entry of await readdir(dir.path, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = basename(entry.name, ".json");
      const previous = files.get(id);
      if (!previous || dir.rank > previous.rank) files.set(id, { id, path: join(dir.path, entry.name), rank: dir.rank });
    }
  }
  return [...files.values()];
}
async function pool(items, worker) {
  const out = new Array(items.length); let cursor = 0;
  async function lane() { while (true) { const index = cursor++; if (index >= items.length) return; out[index] = await worker(items[index]); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, lane)); return out;
}
async function candidate(item) {
  let row; try { row = JSON.parse((await readFile(item.path, "utf8")).replace(/^\uFEFF/, "")); } catch { return undefined; }
  if (row.command_truncated === true || !row.command || row.exit_code === 0 || row.execution_outcome === "success") return undefined;
  const diagnostic = replayFailureDiagnostic(row);
  if (diagnostic?.kind !== "parser_error" || diagnostic.origin !== "python" || diagnostic.boundary !== "legacy_command") return undefined;
  const command = String(row.command);
  const plan = planCommandExecution(command, pwsh);
  const base = String(plan.executable || "").replaceAll("/", "\\").split("\\").at(-1)?.toLowerCase() || "";
  const index = plan.args?.findIndex((value) => value === "-c") ?? -1;
  const code = plan.mode === "native" && ["python", "python.exe", "python3", "python3.exe", "py", "py.exe"].includes(base) && index >= 0 ? plan.args[index + 1] : undefined;
  return { id: item.id, command, runtime_code: diagnostic.code || null, plan_mode: plan.mode, plan_reason: plan.reason, code };
}

const files = await collectFiles();
const candidates = (await pool(files, candidate)).filter(Boolean);
const unique = new Map(); for (const row of candidates) if (!unique.has(row.command)) unique.set(row.command, row);
const rows = [...unique.values()];
const direct = rows.filter((row) => typeof row.code === "string");
const results = new Map();
if (direct.length) {
  const helper = String.raw`import json,sys
for line in sys.stdin:
    row=json.loads(line)
    try:
        compile(row["code"], "<string>", "exec")
        out={"id":row["id"],"valid":True}
    except (SyntaxError,IndentationError,TabError) as exc:
        out={"id":row["id"],"valid":False,"kind":type(exc).__name__,"message":str(exc),"line":getattr(exc,"lineno",None),"offset":getattr(exc,"offset",None)}
    print(json.dumps(out,separators=(",",":")))`;
  const child = spawn("python", ["-c", helper], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (x) => stdout += x); child.stderr.on("data", (x) => stderr += x);
  for (const row of direct) child.stdin.write(`${JSON.stringify({ id: row.id, code: row.code })}\n`); child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (exitCode !== 0) throw new Error(`python compile helper failed exit=${exitCode}: ${stderr.slice(-2000)}`);
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) { const result = JSON.parse(line); results.set(result.id, result); }
}
let valid = 0, invalid = 0; const plans = new Map(), invalidKinds = new Map(); const validSamples = [], invalidSamples = [], otherSamples = [];
for (const row of rows) {
  const key = `${row.plan_mode}:${row.plan_reason}`; plans.set(key, (plans.get(key) || 0) + 1);
  const result = results.get(row.id);
  if (!result) { if (otherSamples.length < 12) otherSamples.push({ id: row.id, plan: key, command: row.command.slice(0, 600) }); continue; }
  if (result.valid) { valid += 1; if (validSamples.length < 12) validSamples.push({ id: row.id, plan: key, code: row.code.slice(0, 500) }); }
  else { invalid += 1; invalidKinds.set(result.kind, (invalidKinds.get(result.kind) || 0) + 1); if (invalidSamples.length < 12) invalidSamples.push({ id: row.id, plan: key, parser: result, code: row.code.slice(0, 500) }); }
}
console.log(JSON.stringify({
  schema: "python-inline-parser-corpus.v1",
  receipt_files: files.length,
  candidate_attempts: candidates.length,
  unique_commands: rows.length,
  current_plan_counts: Object.fromEntries([...plans].sort((a,b)=>b[1]-a[1])),
  direct_inline_code_commands: direct.length,
  direct_inline_code_parser_valid: valid,
  direct_inline_code_parser_invalid: invalid,
  direct_inline_code_valid_pct: Number((100 * valid / Math.max(1, valid + invalid)).toFixed(2)),
  invalid_kinds: Object.fromEntries([...invalidKinds].sort((a,b)=>b[1]-a[1])),
  valid_samples: validSamples,
  invalid_samples: invalidSamples,
  other_plan_samples: otherSamples,
}, null, 2));
