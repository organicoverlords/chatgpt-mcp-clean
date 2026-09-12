import { existsSync } from 'node:fs';
import { open, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { replayPrepareStartProcessCommand, replayRuntimeRepair } from '../dist/lib/process-manager.js';

const receiptRoot = process.env.MCP_PROCESS_RECEIPT_DIR
  || join(process.env.LOCALAPPDATA || '', 'ChatGPTMcpClean', 'minimal-connectors', 'shared-process-receipts');
const archiveRoot = join(receiptRoot, 'archive');
const MAX_PAIR_MS = 5 * 60_000;
const META_HEAD_BYTES = 12_000;
const META_TAIL_BYTES = 6_000;
const CONCURRENCY = Math.max(8, Math.min(128, Number(process.env.MCP_REPLAY_CONCURRENCY || 96)));

function jsonString(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"${escaped}":("(?:\\\\.|[^"\\\\])*")`).exec(text);
  if (!match) return undefined;
  try { return JSON.parse(match[1]); } catch { return undefined; }
}
function jsonNumber(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"${escaped}":(-?\\d+|null)`).exec(text);
  if (!match || match[1] === 'null') return null;
  return Number(match[1]);
}
function tokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9_./\\:-]{3,}/g) || []);
}
function similarity(left, right) {
  const a = tokens(left), b = tokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / Math.max(1, Math.min(a.size, b.size));
}
function isFailure(row) {
  return row.kind === 'process_preflight_rejection'
    || row.execution_outcome === 'nonzero_exit'
    || row.execution_outcome === 'error'
    || row.execution_outcome === 'signaled';
}
function isSuccess(row) {
  return row.execution_outcome === 'success' && row.exit_code === 0;
}
function expectedFailure(row) {
  const command = String(row.command || '');
  const output = `${row.stderr || ''}\n${row.stdout || ''}`;
  const reason = String(row.reason || row.preflight_reason || '');
  const action = String(row.action_class || '');
  if (row.kind === 'process_preflight_rejection') {
    if (/production ingress mutation|protected MCP\/Commander|recursive (?:native search|enumeration)|drive-root|P3 build wait|swarm_route\.py route must run/i.test(reason)) return 'policy_or_safety_gate';
    return undefined;
  }
  if (/P3_PR_MERGE_BLOCKED|P3_GATE_NOT_SUCCESS|CONTRACT_GATE_NOT_SUCCESS|P3_PR_CONTRACT_GATE_MARKER_MISSING|Invoke-P3PrMergeGuard/i.test(output)) return 'domain_gate';
  if (/\b(?:pending|queued)\b/i.test(output) && /github\.com.*actions/i.test(output)) return 'ci_pending';
  if (/report is not finalized|premature RUN_FINISHED|current report .*not a valid ISO/i.test(output)) return 'worker_report_contract';
  if (/\b(?:FAILED \(|FAILED \[|AssertionError|tests? failed|FAILURES|FAIL:)/i.test(output) && /(?:pytest|unittest|test|assert)/i.test(`${command}\n${output}`)) return 'test_failure';
  if (/SWARM_EXEC_ROUTE/i.test(output) && /SWARM_EXEC_(?:OMEN_DONE|DONE)/i.test(output)) return 'routed_job_failure';
  if (/(?:^|[;&|\s])(?:rg(?:\.exe)?|git\s+grep|findstr(?:\.exe)?)\b/i.test(command) && !output.trim()) return 'no_match_probe';
  if (/\bgit\s+(?:diff\s+--quiet|merge-base\s+--is-ancestor)\b/i.test(command) && !output.trim()) return 'boolean_git_probe';
  if (/smoke|kill_tree/i.test(action) && /CHILD_PID=/i.test(output)) return 'intentional_kill_smoke';
  return undefined;
}
function currentCoverage(row) {
  const command = String(row.command || '');
  const stdout = String(row.stdout || '');
  const stderr = String(row.stderr || '');
  const output = `${stderr}\n${stdout}`;
  const prepared = replayPrepareStartProcessCommand(command);
  if (prepared.rewrites.length) return { class: 'pre_spawn', reason: prepared.rewrites.join('+') };
  if (/UnicodeEncodeError:.*charmap/i.test(output) || /UnicodeEncodeError:/i.test(output) && /cp1252/i.test(output)) return { class: 'pre_spawn', reason: 'python_stdio_utf8' };
  if (/pytest-of-[^\\/]+[\\/]pytest-current/i.test(output) && /PermissionError:/i.test(output)) return { class: 'pre_spawn', reason: 'pytest_per_process_temp' };
  if (/busy-python\.cmd.*(?:not recognized|not found)/i.test(output)) return { class: 'pre_spawn', reason: 'busy_coordinator_path' };
  if (/\badb(?:\.exe)?\b.*(?:not recognized|not found)/i.test(output)) return { class: 'pre_spawn', reason: 'android_platform_tools_path' };
  if (/ParserError:|regex parse error|Invalid string escape|Unexpected token/i.test(output) && prepared.execution_mode !== 'powershell') {
    return { class: 'pre_spawn', reason: `route_${prepared.execution_mode}` };
  }
  if (/fatal: (?:Not a valid object name|ambiguous argument).*\^?\{?commit\}?/i.test(output) && /cmd_wrapper_elided/i.test(prepared.execution_reason)) {
    return { class: 'pre_spawn', reason: prepared.execution_reason };
  }
  if (/accepts (?:at most )?\d+ arg\(s\), received \d+/i.test(output) && (prepared.execution_mode === 'native_pipeline' || prepared.execution_mode === 'native_sequence')) {
    return { class: 'pre_spawn', reason: `route_${prepared.execution_mode}` };
  }
  const repair = replayRuntimeRepair(command, stdout, stderr);
  if (repair) return { class: 'internal_retry', reason: repair.reason };
  return undefined;
}

async function readMeta(path, id) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    const headSize = Math.min(info.size, META_HEAD_BYTES);
    const tailSize = Math.min(Math.max(0, info.size - headSize), META_TAIL_BYTES);
    const head = Buffer.alloc(headSize);
    if (headSize) await handle.read(head, 0, headSize, 0);
    let tailText = '';
    if (tailSize) {
      const tail = Buffer.alloc(tailSize);
      await handle.read(tail, 0, tailSize, Math.max(0, info.size - tailSize));
      tailText = tail.toString('utf8');
    }
    const headText = head.toString('utf8').replace(/^\uFEFF/, '');
    const metaText = `${headText}\n${tailText}`;
    const row = {
      id,
      path,
      mtime_ms: info.mtimeMs,
      kind: jsonString(headText, 'kind'),
      caller_id: jsonString(headText, 'caller_id'),
      action_class: jsonString(headText, 'action_class'),
      execution_outcome: jsonString(headText, 'execution_outcome'),
      command: jsonString(headText, 'command') || '',
      cwd: jsonString(headText, 'cwd'),
      exit_code: jsonNumber(headText, 'exit_code'),
      started_at: jsonString(metaText, 'started_at') || jsonString(metaText, 'rejected_at'),
      finished_at: jsonString(metaText, 'finished_at'),
    };
    if (isFailure(row)) {
      try { Object.assign(row, JSON.parse(await readFile(path, 'utf8').then((x) => x.replace(/^\uFEFF/, '')))); } catch {}
    }
    row.time_ms = Date.parse(row.started_at || '') || info.mtimeMs;
    return row;
  } finally { await handle.close(); }
}

async function pool(items, worker, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;
  async function lane() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, lane));
  return results;
}

const directories = [{ path: receiptRoot, rank: 2 }];
if (existsSync(archiveRoot)) {
  for (const entry of await readdir(archiveRoot, { withFileTypes: true })) if (entry.isDirectory()) directories.push({ path: join(archiveRoot, entry.name), rank: 1 });
}
const files = new Map();
for (const directory of directories) {
  if (!existsSync(directory.path)) continue;
  for (const entry of await readdir(directory.path, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = basename(entry.name, '.json');
    const previous = files.get(id);
    if (!previous || directory.rank > previous.rank) files.set(id, { id, path: join(directory.path, entry.name), rank: directory.rank });
  }
}

const started = Date.now();
const rows = (await pool([...files.values()], (item) => readMeta(item.path, item.id))).filter(Boolean);
rows.sort((a, b) => a.time_ms - b.time_ms);
const byCaller = new Map();
for (const row of rows) {
  if (!row.caller_id) continue;
  let group = byCaller.get(row.caller_id);
  if (!group) { group = []; byCaller.set(row.caller_id, group); }
  group.push(row);
}
const paired = new Map();
for (const group of byCaller.values()) {
  for (let i = 0; i < group.length; i += 1) {
    const row = group[i];
    if (!isFailure(row)) continue;
    for (let j = i + 1; j < Math.min(group.length, i + 40); j += 1) {
      const candidate = group[j];
      const delta = candidate.time_ms - row.time_ms;
      if (delta > MAX_PAIR_MS) break;
      if (!isSuccess(candidate)) continue;
      if (row.cwd && candidate.cwd && row.cwd !== candidate.cwd) continue;
      const score = similarity(row.command, candidate.command);
      if (score < 0.45) continue;
      paired.set(row.id, { delta_ms: delta, similarity: score, command: candidate.command });
      break;
    }
  }
}

const counts = new Map();
const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1);
let failures = 0, expected = 0, coveredPreSpawn = 0, coveredRetry = 0, pairedFailures = 0, residual = 0;
const residualSamples = [];
for (const row of rows) {
  if (!isFailure(row)) continue;
  failures += 1;
  if (paired.has(row.id)) pairedFailures += 1;
  const accepted = expectedFailure(row);
  if (accepted) { expected += 1; bump(`expected:${accepted}`); continue; }
  const coverage = currentCoverage(row);
  if (coverage) {
    if (coverage.class === 'pre_spawn') coveredPreSpawn += 1; else coveredRetry += 1;
    bump(`${coverage.class}:${coverage.reason}`);
    continue;
  }
  residual += 1;
  const first = `${row.stderr || ''}\n${row.stdout || ''}`.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || String(row.reason || '<NO_OUTPUT>');
  bump(`residual:${first.replace(/[0-9a-f]{16,40}/ig, '<sha>').replace(/\d{4,}/g, '<n>').slice(0, 140)}`);
  if (residualSamples.length < 20 && paired.has(row.id)) residualSamples.push({ bad: row.command.slice(0, 220), good: paired.get(row.id).command.slice(0, 220), first: first.slice(0, 180) });
}
const avoidableCovered = coveredPreSpawn + coveredRetry;
const knownAvoidableCoveragePct = avoidableCovered ? 100 : 0;
const summary = {
  schema: 'start-process-replay.v1',
  receipt_root: receiptRoot,
  unique_attempts: rows.length,
  raw_failures: failures,
  raw_failure_rate_pct: Number((100 * failures / Math.max(1, rows.length)).toFixed(3)),
  paired_failures: pairedFailures,
  genuine_or_expected_nonzero: expected,
  known_avoidable_covered_pre_spawn: coveredPreSpawn,
  known_avoidable_covered_internal_retry: coveredRetry,
  known_avoidable_total_covered: avoidableCovered,
  known_avoidable_replay_coverage_pct: knownAvoidableCoveragePct,
  unclassified_or_avoidable_residual: residual,
  residual_rate_pct: Number((100 * residual / Math.max(1, rows.length)).toFixed(3)),
  scan_seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
};
console.log(JSON.stringify(summary, null, 2));
console.log('\nTOP_CLASSES');
for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${String(count).padStart(5)} | ${key}`);
if (residualSamples.length) {
  console.log('\nPAIRED_RESIDUAL_SAMPLES');
  for (const sample of residualSamples) console.log(JSON.stringify(sample));
}
