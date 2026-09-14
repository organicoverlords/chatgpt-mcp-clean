import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { replayFailureDiagnostic, replayPrepareStartProcessCommand } from "../dist/lib/process-manager.js";

const root = process.env.MCP_REPLAY_ROOT || join(process.env.LOCALAPPDATA || "", "ChatGPTMcpClean", "minimal-connectors", "shared-process-receipts");
const archive = join(root, "archive");
const concurrency = Math.max(1, Math.min(64, Number(process.env.MCP_PARSER_SCAN_CONCURRENCY || 24)));
const pwsh = process.env.MCP_POWERSHELL_EXE || "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

async function collectFiles() {
  const files = new Map();
  const dirs = [{ path: root, rank: 2 }];
  if (existsSync(archive)) {
    for (const entry of await readdir(archive, { withFileTypes: true })) if (entry.isDirectory()) dirs.push({ path: join(archive, entry.name), rank: 1 });
  }
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
  const out = new Array(items.length);
  let cursor = 0;
  async function lane() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, lane));
  return out;
}

async function candidate(item) {
  let row;
  try { row = JSON.parse((await readFile(item.path, "utf8")).replace(/^\uFEFF/, "")); } catch { return undefined; }
  if (row.command_truncated === true || !row.command) return undefined;
  if (row.exit_code === 0 || row.execution_outcome === "success") return undefined;
  const diagnostic = replayFailureDiagnostic(row);
  if (diagnostic?.kind !== "parser_error" || diagnostic.origin !== "powershell" || diagnostic.boundary !== "legacy_command") return undefined;
  return {
    id: item.id,
    command: String(row.command),
    runtime_code: diagnostic.code || null,
    execution_reason: String(row.execution_reason || ""),
    stderr: String(row.stderr || ""),
    stdout: String(row.stdout || ""),
    error: String(row.error || ""),
    current_plan: replayPrepareStartProcessCommand(String(row.command)),
  };
}

const helperPath = join(tmpdir(), `mcp-ps-parser-${randomUUID()}.ps1`);
const helper = String.raw`$ErrorActionPreference='Stop'
$input | ForEach-Object {
  $row = $_ | ConvertFrom-Json
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseInput([string]$row.command, [ref]$tokens, [ref]$errors) | Out-Null
  $items = @($errors | ForEach-Object {
    [pscustomobject]@{
      id = [string]$_.ErrorId
      message = [string]$_.Message
      start = [int]$_.Extent.StartOffset
      end = [int]$_.Extent.EndOffset
    }
  })
  [pscustomobject]@{ id=[string]$row.id; valid=($items.Count -eq 0); errors=$items } | ConvertTo-Json -Compress -Depth 5
}`;
await writeFile(helperPath, helper, "utf8");

try {
  const files = await collectFiles();
  const candidates = (await pool(files, candidate)).filter(Boolean);
  const unique = new Map();
  for (const row of candidates) if (!unique.has(row.command)) unique.set(row.command, row);
  const rows = [...unique.values()];

  const child = spawn(pwsh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helperPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  for (const row of rows) child.stdin.write(`${JSON.stringify({ id: row.id, command: row.command })}\n`);
  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  if (exitCode !== 0) throw new Error(`PowerShell parser helper failed exit=${exitCode}: ${stderr.slice(-4000)}`);

  const parsed = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const byId = new Map(parsed.map((row) => [row.id, row]));
  let valid = 0, invalid = 0;
  const includeIds = (process.env.MCP_PARSER_INCLUDE_IDS || "").trim() === "1";
  const parserValidIds = [];
  const parserInvalidIds = [];
  const errorIds = new Map();
  const runtimeCodes = new Map();
  const validShapes = new Map();
  const validCurrentPlans = new Map();
  const validCurrentNonPowerShell = new Map();
  const powershellSurvivorReasons = new Map();
  const validSamples = [], invalidSamples = [];
  const validByShape = new Map();
  function powershellSurvivorReason(source, shape) {
    if (source.current_plan.execution_mode !== "powershell") return undefined;
    const failure = `${source.stderr}\n${source.error}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    if (shape === "nested_powershell_double_quote_expansion") return "compound_nested_shell_transport";
    if (shape === "explicit_parser_api") return "nested_parser_target";
    if (/ParserError:\s+[^\r\n]*\.ps1:\d+|At [^\r\n]*\.ps1:\d+ char:/i.test(failure) || /FullyQualifiedErrorId\s*:[^\r\n]*,[^\r\n]*\.ps1/i.test(failure)) return "inner_script_source_error";
    if (["AmpersandNotAllowed", "InvalidEndOfLine"].includes(source.runtime_code)) return "runtime_dialect_mismatch";
    if (source.runtime_code === "TerminatorExpectedAtEndOfString") return "runtime_quote_or_dialect";
    if (!source.runtime_code) return "uncertain_no_runtime_code";
    return "other_runtime_parser_error";
  }

  function validShape(source) {
    const command = source.command;
    const nestedPs = /\b(?:powershell|pwsh)(?:\.exe)?\b[\s\S]*?(?:-Command|-c)\s+"/i.test(command);
    if (nestedPs) {
      const nestedStart = command.search(/\b(?:powershell|pwsh)(?:\.exe)?\b/i);
      const nested = nestedStart >= 0 ? command.slice(nestedStart) : command;
      if (/\$(?:_|[A-Za-z])/i.test(nested)) return "nested_powershell_double_quote_expansion";
      return "nested_powershell_command";
    }
    if (/\b(?:powershell|pwsh)(?:\.exe)?\b[\s\S]*?-EncodedCommand\b/i.test(command)) return "encoded_command";
    if (/\[System\.Management\.Automation\.Language\.Parser\]::Parse(?:File|Input)|\[scriptblock\]::Create/i.test(command)) return "explicit_parser_api";
    if (/\.(?:ps1)\b/i.test(command) && /(?:^|[;|&\s])(?:&\s*)?["']?[^"'\r\n]*\.ps1/i.test(command)) return "script_file_execution";
    if (/(?:^|[;&|\s])(?:python(?:3)?|py)(?:\.exe)?\s+-c\b/i.test(command)) return "inline_python";
    if (/(?:^|[;&|\s])node(?:\.exe)?\s+(?:-e|--eval)\b/i.test(command)) return "inline_node";
    if (/Invoke-Expression|\biex\b/i.test(command)) return "invoke_expression";
    return "other_outer_valid";
  }
  for (const source of rows) {
    const result = byId.get(source.id);
    if (!result) continue;
    if (source.runtime_code) runtimeCodes.set(source.runtime_code, (runtimeCodes.get(source.runtime_code) || 0) + 1);
    if (result.valid) {
      valid += 1;
      if (includeIds) parserValidIds.push(source.id);
      const shape = validShape(source);
      validShapes.set(shape, (validShapes.get(shape) || 0) + 1);
      const planKey = `${source.current_plan.execution_mode}:${source.current_plan.execution_reason}`;
      validCurrentPlans.set(planKey, (validCurrentPlans.get(planKey) || 0) + 1);
      if (source.current_plan.execution_mode !== "powershell") validCurrentNonPowerShell.set(shape, (validCurrentNonPowerShell.get(shape) || 0) + 1);
      const survivorReason = powershellSurvivorReason(source, shape);
      if (survivorReason) powershellSurvivorReasons.set(survivorReason, (powershellSurvivorReasons.get(survivorReason) || 0) + 1);
      if (!validByShape.has(shape)) validByShape.set(shape, []);
      if (validByShape.get(shape).length < 8) validByShape.get(shape).push({
        id: source.id,
        runtime_code: source.runtime_code,
        execution_reason: source.execution_reason,
        current_execution_mode: source.current_plan.execution_mode,
        current_execution_reason: source.current_plan.execution_reason,
        current_rewrites: source.current_plan.rewrites,
        command: source.command.slice(0, 700),
        failure_tail: `${source.stderr}\n${source.stdout}\n${source.error}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").slice(-700),
      });
      if (validSamples.length < 12) validSamples.push({ id: source.id, runtime_code: source.runtime_code, shape, command: source.command.slice(0, 500) });
    } else {
      invalid += 1;
      if (includeIds) parserInvalidIds.push(source.id);
      for (const error of result.errors || []) errorIds.set(error.id || "<none>", (errorIds.get(error.id || "<none>") || 0) + 1);
      if (invalidSamples.length < 12) invalidSamples.push({ id: source.id, runtime_code: source.runtime_code, parser_errors: result.errors, command: source.command.slice(0, 500) });
    }
  }
  console.log(JSON.stringify({
    schema: "powershell-parser-corpus.v1",
    receipt_files: files.length,
    candidate_attempts: candidates.length,
    unique_commands: rows.length,
    parser_valid_unique_commands: valid,
    parser_invalid_unique_commands: invalid,
    parser_valid_pct: Number((100 * valid / Math.max(1, valid + invalid)).toFixed(2)),
    ...(includeIds ? { parser_valid_ids: parserValidIds, parser_invalid_ids: parserInvalidIds } : {}),
    top_official_parser_error_ids: Object.fromEntries([...errorIds].sort((a,b)=>b[1]-a[1]).slice(0,20)),
    runtime_failure_codes: Object.fromEntries([...runtimeCodes].sort((a,b)=>b[1]-a[1]).slice(0,20)),
    parser_valid_shape_counts: Object.fromEntries([...validShapes].sort((a,b)=>b[1]-a[1])),
    parser_valid_current_plan_counts: Object.fromEntries([...validCurrentPlans].sort((a,b)=>b[1]-a[1])),
    parser_valid_current_non_powershell_by_shape: Object.fromEntries([...validCurrentNonPowerShell].sort((a,b)=>b[1]-a[1])),
    parser_valid_powershell_survivor_reason_counts: Object.fromEntries([...powershellSurvivorReasons].sort((a,b)=>b[1]-a[1])),
    parser_valid_samples_by_shape: Object.fromEntries([...validByShape].sort((a,b)=>b[1].length-a[1].length)),
    valid_samples: validSamples,
    invalid_samples: invalidSamples,
  }, null, 2));
} finally {
  await rm(helperPath, { force: true });
}
