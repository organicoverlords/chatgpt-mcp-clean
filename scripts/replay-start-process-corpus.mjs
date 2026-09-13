import { existsSync } from 'node:fs';
import { open, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { replayCurrentPreflightError, replayFailureDiagnostic, replayPrepareStartProcessCommand, replayRuntimeRepair } from '../dist/lib/process-manager.js';

const receiptRoot = process.env.MCP_PROCESS_RECEIPT_DIR
  || join(process.env.LOCALAPPDATA || '', 'ChatGPTMcpClean', 'minimal-connectors', 'shared-process-receipts');
const archiveRoot = join(receiptRoot, 'archive');
const MAX_PAIR_MS = 5 * 60_000;
const META_HEAD_BYTES = 12_000;
const META_TAIL_BYTES = 6_000;
const CONCURRENCY = Math.max(8, Math.min(128, Number(process.env.MCP_REPLAY_CONCURRENCY || 96)));
const REPLAY_SCOPE = (process.env.MCP_REPLAY_SCOPE || 'all').trim();
const SAMPLE_MATCH_RAW = (process.env.MCP_REPLAY_SAMPLE_MATCH || '').trim();
const SAMPLE_MATCH = SAMPLE_MATCH_RAW ? new RegExp(SAMPLE_MATCH_RAW, 'i') : undefined;
const SAMPLE_LIMIT = Math.max(1, Math.min(100, Number(process.env.MCP_REPLAY_SAMPLE_LIMIT || 20)));

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
function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function expectedFailure(row) {
  const command = String(row.command || '');
  const output = stripAnsi(`${row.error || ''}\n${row.stderr || ''}\n${row.stdout || ''}`);
  const reason = String(row.reason || row.preflight_reason || '');
  const action = String(row.action_class || '');
  if (row.kind === 'process_preflight_rejection') {
    if (/production ingress mutation|protected MCP\/Commander|recursive (?:native search|enumeration)|drive-root|P3 build wait|swarm_route\.py route must run/i.test(reason)) return 'policy_or_safety_gate';
    return undefined;
  }
  if (/P3_PR_MERGE_BLOCKED|P3_GATE_NOT_SUCCESS|CONTRACT_GATE_NOT_SUCCESS|P3_PR_CONTRACT_GATE_MARKER_MISSING|Invoke-P3PrMergeGuard/i.test(output)) return 'domain_gate';
  if (/P3_BUILD_ROUTE_TIMEOUT/i.test(output)) return 'build_queue_admission';
  if (/CORE_PROBE[^\r\n]*state=(?:PRESSURE_BLOCKED|RECOVERY_(?:OBSERVED|HOLD|CONFIRM))[^\r\n]*admit=False/i.test(output)) return 'resource_admission';
  if (/run \d+ is still in progress; logs will be available when it is complete/i.test(output)) return 'ci_pending';
  if (/GraphQL: Merge already in progress \(mergePullRequest\)/i.test(output)) return 'remote_merge_in_progress';
  if (/(?:CONFLICT \(|Rebasing \(\d+\/\d+\)[\s\S]{0,1200}error: could not apply)/i.test(output)) return 'git_conflict_state';
  if (/visual proof rule missing: must inspect its own actual captured pixels\/video/i.test(output)) return 'domain_gate';
  if (/Traceback \(most recent call last\):/i.test(output)
      && /(?:^|\n)[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception):/m.test(output)
      && !/(?:SyntaxError|IndentationError|TabError|UnicodeEncodeError|BrokenPipeError):/i.test(output)) return 'python_runtime_or_domain_error';
  if (/Exception:/i.test(output) && /\bthrow\b/i.test(command)) return 'explicit_domain_guard';
  if (/(?:Get-Content|Get-Item|Get-FileHash): Cannot find path|FileNotFoundError:|The argument .* is not recognized as the name of a script file/i.test(output)) return 'missing_input_or_artifact';
  if (/gh: Not Found \(HTTP 404\)/i.test(output)) return 'remote_resource_missing';
  if (/tiny3d: error: (?:source reference|historical review campaign|asset|workspace|selection)/i.test(output)) return 'tiny3d_domain_error';
  if (/reported started_at changed after timed run begin|unknown finding_tags:|literal slopwall correction requires/i.test(output)) return 'contract_validation';
  if (/List of devices attached/i.test(output) && /\badb(?:\.exe)?\b[\s\S]*\bshell\s+pm\s+path\b/i.test(command)) return 'android_package_state';
  if (/cmd: Can't find service: package/i.test(output)) return 'android_package_state';
  if (/\b(?:pending|queued)\b/i.test(output) && /github\.com.*actions/i.test(output)) return 'ci_pending';
  if (/report is not finalized|premature RUN_FINISHED|current report .*not a valid ISO/i.test(output)) return 'worker_report_contract';
  if (/\b(?:FAILED \(|FAILED \[|AssertionError|tests? failed|FAILURES|FAIL:)/i.test(output) && /(?:pytest|unittest|test|assert)/i.test(`${command}\n${output}`)) return 'test_failure';
  if (/SWARM_EXEC_ROUTE/i.test(output) && /SWARM_EXEC_(?:OMEN_DONE|DONE)/i.test(output)) return 'routed_job_failure';
  if (/(?:^|[;&|\s])(?:rg(?:\.exe)?|git\s+grep|findstr(?:\.exe)?)\b/i.test(command) && !output.trim()) return 'no_match_probe';
  if (/\bgit\s+(?:diff\s+--quiet|merge-base\s+--is-ancestor)\b/i.test(command) && !output.trim()) return 'boolean_git_probe';
  if (/smoke|kill_tree/i.test(action) && /CHILD_PID=/i.test(output)) return 'intentional_kill_smoke';
  return undefined;
}
function isLegacyShellSurfaceCoverage(coverage) {
  if (!coverage || coverage.class !== 'pre_spawn') return false;
  const reasons = String(coverage.reason || '').split('+');
  return reasons.some((reason) => /^(?:powershell_c_style_quote_escape|powershell_interpolation_literal|powershell_here_string_newline|route_(?:native|explicit_shell|native_sequence|native_pipeline)|python_heredoc_to_stdin|cmd_wrapper_elided|inline_code_argv_direct)$/.test(reason));
}

function residualCandidate(row) {
  const command = String(row.command || '');
  const output = stripAnsi(`${row.error || ''}\n${row.stderr || ''}\n${row.stdout || ''}`);
  const inlinePython = /(?:^|[;&|\s])(?:python(?:3)?|py)(?:\.exe)?\s+-c\b/i.test(command);
  if (inlinePython && /\bbase64\.(?:b64decode|urlsafe_b64decode)\s*\(/i.test(command)) {
    return { group: 'legacy_transport', reason: 'encoded_python_command' };
  }
  const diagnostic = replayFailureDiagnostic(row);
  if (diagnostic) return { group: 'failure_diagnostic', reason: `${diagnostic.kind}:${diagnostic.origin}:${diagnostic.boundary}`, diagnostic };
  if (inlinePython && /File "<string>", line 1/i.test(output) && /SyntaxError:/i.test(output)) {
    return { group: 'legacy_transport', reason: 'python_inline_code_quoting' };
  }
  if (/ParserError:/i.test(output)) return { group: 'parser_review', reason: 'unrouted_parser_error' };
  if (!output.trim()) return { group: 'unknown', reason: 'no_output' };
  return undefined;
}

function currentCoverage(row) {
  const command = String(row.command || '');
  const stdout = String(row.stdout || '');
  const stderr = String(row.stderr || '');
  const output = `${row.error || ''}\n${stderr}\n${stdout}`;
  const prepared = replayPrepareStartProcessCommand(command);
  if (prepared.rewrites.length) return { class: 'pre_spawn', reason: prepared.rewrites.join('+') };
  if (row.kind === 'process_preflight_rejection' && replayCurrentPreflightError(command) === undefined) {
    return { class: 'pre_spawn', reason: 'current_preflight_accepts' };
  }
  if (/UnicodeEncodeError:.*charmap/i.test(output) || /UnicodeEncodeError:/i.test(output) && /cp1252/i.test(output)) return { class: 'pre_spawn', reason: 'python_stdio_utf8' };
  if (/pytest-of-[^\\/]+[\\/]pytest-current/i.test(output) && /PermissionError:/i.test(output)) return { class: 'pre_spawn', reason: 'pytest_per_process_temp' };
  if (/busy-python\.cmd.*(?:not recognized|not found)/i.test(output)) return { class: 'pre_spawn', reason: 'busy_coordinator_path' };
  if (/process launcher unavailable: --input-type can only be used with string input/i.test(output)) return { class: 'pre_spawn', reason: 'worker_execargv_sanitized' };
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

const directories = [];
if (REPLAY_SCOPE === 'all' || REPLAY_SCOPE === 'current') directories.push({ path: receiptRoot, rank: 2 });
if (REPLAY_SCOPE === 'all' && existsSync(archiveRoot)) {
  for (const entry of await readdir(archiveRoot, { withFileTypes: true })) if (entry.isDirectory()) directories.push({ path: join(archiveRoot, entry.name), rank: 1 });
} else if (REPLAY_SCOPE.startsWith('day:')) {
  const day = REPLAY_SCOPE.slice('day:'.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`invalid MCP_REPLAY_SCOPE day: ${REPLAY_SCOPE}`);
  directories.push({ path: join(archiveRoot, day), rank: 1 });
} else if (REPLAY_SCOPE !== 'all' && REPLAY_SCOPE !== 'current') {
  throw new Error(`invalid MCP_REPLAY_SCOPE: ${REPLAY_SCOPE}`);
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
      if (row.action_class && candidate.action_class && row.action_class !== candidate.action_class) continue;
      if (row.activity_target && candidate.activity_target && JSON.stringify(row.activity_target) !== JSON.stringify(candidate.activity_target)) continue;
      const score = similarity(row.command, candidate.command);
      if (score < 0.60) continue;
      paired.set(row.id, { delta_ms: delta, similarity: score, command: candidate.command });
      break;
    }
  }
}

const counts = new Map();
const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1);
let failures = 0, expected = 0, coveredPreSpawn = 0, coveredRetry = 0, coveredLegacyShellSurface = 0, pairedFailures = 0, insufficientEvidence = 0, residual = 0;
const residualSamples = [];
const matchedSamples = [];
const residualCandidates = new Map();
const silentNonzeroByExitCode = new Map();
const silentNonzeroByExecutionReason = new Map();
let failureDiagnosticMatches = 0;
let failureDiagnosticInputTargets = 0;
for (const row of rows) {
  if (!isFailure(row)) continue;
  failures += 1;
  if (paired.has(row.id)) pairedFailures += 1;
  const accepted = expectedFailure(row);
  if (accepted) { expected += 1; bump(`expected:${accepted}`); continue; }
  const coverage = currentCoverage(row);
  if (coverage) {
    if (coverage.class === 'pre_spawn') coveredPreSpawn += 1; else coveredRetry += 1;
    if (isLegacyShellSurfaceCoverage(coverage)) coveredLegacyShellSurface += 1;
    bump(`${coverage.class}:${coverage.reason}`);
    continue;
  }
  if (row.command_truncated === true) {
    insufficientEvidence += 1;
    bump('insufficient_evidence:command_truncated');
    continue;
  }
  residual += 1;
  const candidate = residualCandidate(row);
  if (!String(row.error || '').trim() && !String(row.stderr || '').trim() && !String(row.stdout || '').trim()) {
    const exitKey = String(row.exit_code);
    silentNonzeroByExitCode.set(exitKey, (silentNonzeroByExitCode.get(exitKey) || 0) + 1);
    const reasonKey = String(row.execution_reason || '<none>');
    silentNonzeroByExecutionReason.set(reasonKey, (silentNonzeroByExecutionReason.get(reasonKey) || 0) + 1);
  }
  if (candidate) {
    const key = `${candidate.group}:${candidate.reason}`;
    residualCandidates.set(key, (residualCandidates.get(key) || 0) + 1);
    if (candidate.group === 'failure_diagnostic') {
      failureDiagnosticMatches += 1;
      if (candidate.diagnostic?.input_target) failureDiagnosticInputTargets += 1;
    }
  }
  const first = `${row.error || ''}\n${row.stderr || ''}\n${row.stdout || ''}`.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || String(row.reason || '<NO_OUTPUT>');
  bump(`residual:${first.replace(/[0-9a-f]{16,40}/ig, '<sha>').replace(/\d{4,}/g, '<n>').slice(0, 140)}`);
  if (residualSamples.length < 20 && paired.has(row.id)) residualSamples.push({ bad: row.command.slice(0, 220), good: paired.get(row.id).command.slice(0, 220), first: first.slice(0, 180) });
  if (SAMPLE_MATCH && matchedSamples.length < SAMPLE_LIMIT && SAMPLE_MATCH.test(`${first}\n${row.error || ''}\n${row.stderr || ''}\n${row.stdout || ''}\n${row.command || ''}`)) {
    matchedSamples.push({ id: row.id, kind: row.kind, exit_code: row.exit_code, signal: row.signal, execution_mode: row.execution_mode, execution_reason: row.execution_reason, command: row.command, first, stderr: String(row.stderr || '').slice(0, 2000), stdout: String(row.stdout || '').slice(0, 1200) });
  }
}
const avoidableCovered = coveredPreSpawn + coveredRetry;
const resolvedOrExpected = expected + avoidableCovered;
const summary = {
  schema: 'start-process-replay.v1',
  receipt_root: receiptRoot,
  replay_scope: REPLAY_SCOPE,
  unique_attempts: rows.length,
  raw_failures: failures,
  raw_failure_rate_pct: Number((100 * failures / Math.max(1, rows.length)).toFixed(3)),
  paired_failures: pairedFailures,
  genuine_or_expected_nonzero: expected,
  known_avoidable_covered_pre_spawn: coveredPreSpawn,
  known_avoidable_covered_internal_retry: coveredRetry,
  known_avoidable_total_covered: avoidableCovered,
  known_avoidable_share_of_raw_failures_pct: Number((100 * avoidableCovered / Math.max(1, failures)).toFixed(3)),
  resolved_or_expected_total: resolvedOrExpected,
  resolved_or_expected_share_of_raw_failures_pct: Number((100 * resolvedOrExpected / Math.max(1, failures)).toFixed(3)),
  known_avoidable_legacy_shell_surface: coveredLegacyShellSurface,
  known_avoidable_other_runtime_or_semantic: avoidableCovered - coveredLegacyShellSurface,
  legacy_shell_surface_rate_pct_of_all_attempts: Number((100 * coveredLegacyShellSurface / Math.max(1, rows.length)).toFixed(3)),
  insufficient_evidence: insufficientEvidence,
  insufficient_evidence_share_of_raw_failures_pct: Number((100 * insufficientEvidence / Math.max(1, failures)).toFixed(3)),
  unclassified_or_avoidable_residual: residual,
  residual_rate_pct: Number((100 * residual / Math.max(1, rows.length)).toFixed(3)),
  failure_diagnostic_matches: failureDiagnosticMatches,
  failure_diagnostic_input_targets: failureDiagnosticInputTargets,
  silent_nonzero_by_exit_code: Object.fromEntries([...silentNonzeroByExitCode].sort((a, b) => b[1] - a[1])),
  silent_nonzero_by_execution_reason: Object.fromEntries([...silentNonzeroByExecutionReason].sort((a, b) => b[1] - a[1]).slice(0, 20)),
  residual_candidate_breakdown: Object.fromEntries([...residualCandidates].sort((a, b) => b[1] - a[1])),
  residual_candidate_note: 'diagnostics are bounded routing metadata only; incomplete receipts are separated from residual; diagnostic candidate buckets are not counted as fixed or avoidable until separately proven',
  scan_seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
};
console.log(JSON.stringify(summary, null, 2));
console.log('\nTOP_CLASSES');
for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${String(count).padStart(5)} | ${key}`);
if (residualSamples.length) {
  console.log('\nPAIRED_RESIDUAL_SAMPLES');
  for (const sample of residualSamples) console.log(JSON.stringify(sample));
}
if (matchedSamples.length) {
  console.log(`\nMATCHED_RESIDUAL_SAMPLES pattern=${JSON.stringify(SAMPLE_MATCH_RAW)}`);
  for (const sample of matchedSamples) console.log(JSON.stringify(sample));
}
