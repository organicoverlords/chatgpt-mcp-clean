import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const origin = (process.env.MCP_SMOKE_ORIGIN || process.env.MCP_PUBLIC_ORIGIN || "http://127.0.0.1:3000").replace(/\/$/, "");
const publicOrigin = (process.env.MCP_SMOKE_PUBLIC_ORIGIN || origin).replace(/\/$/, "");
const ownerLogin = (process.env.TAILSCALE_OWNER_LOGIN || "owner@example.com").trim();
const ownerAuthMode = (process.env.MCP_OWNER_AUTH_MODE || "tailscale").trim().toLowerCase();
const redirectUri = "https://chatgpt.com/connector/oauth/smoke";
const resource = `${publicOrigin}/mcp`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toolProfile = (process.env.MCP_TOOL_PROFILE || "process").trim().toLowerCase();
const expectedTools = toolProfile === "process"
  ? ["download_chatgpt_file", "kill_process", "read_output", "start_process", "upload_local_file"]
  : ["busy_claim", "busy_list", "busy_release", "download_chatgpt_file", "kill_process", "read_output", "start_process", "upload_local_file", "view_image"];

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body, text };
}

const registration = await jsonFetch(`${origin}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "shell-mcp-smoke",
  }),
});
assert.equal(registration.response.status, 201, registration.text);
assert.equal(registration.response.headers.get("ratelimit-policy"), "300;w=3600");
const client = registration.body;
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd";
const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
const authorizationUrl = new URL(`${origin}/authorize`);
for (const [key, value] of Object.entries({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: redirectUri,
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource,
  scope: "mcp offline_access",
  state: "shell-mcp-smoke",
})) authorizationUrl.searchParams.set(key, value);
const authorizationHeaders = ownerAuthMode === "local-edge"
  ? { host: new URL(publicOrigin).host, "x-forwarded-for": "192.168.1.50" }
  : { "tailscale-user-login": ownerLogin };
const authorization = await fetch(authorizationUrl, { redirect: "manual", headers: authorizationHeaders });
assert.equal(authorization.status, 302, await authorization.text());
const code = new URL(authorization.headers.get("location")).searchParams.get("code");
assert.ok(code);

const token = await jsonFetch(`${origin}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource,
  }),
});
assert.equal(token.response.status, 200, token.text);
const accessToken = token.body.access_token;
const refreshToken = token.body.refresh_token;
assert.ok(accessToken && refreshToken);
for (let i = 0; i < 2; i++) {
  const refreshed = await jsonFetch(`${origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: refreshToken, resource, scope: "mcp offline_access" }),
  });
  assert.equal(refreshed.response.status, 200, refreshed.text);
}

const auth = `Bearer ${accessToken}`;
async function mcpPost(sessionId, message) {
  const headers = { authorization: auth, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const result = await jsonFetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
  assert.ok(result.response.ok, `${result.response.status}: ${result.text}`);
  if (typeof result.body === "string" && result.response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = [...result.text.matchAll(/^data:\s*(.+)$/gm)].at(-1)?.[1];
    assert.ok(data, result.text);
    result.body = JSON.parse(data);
  }
  return result;
}
async function initialize() {
  const result = await mcpPost(undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shell-mcp-smoke", version: "1.0.0" } } });
  const sessionId = result.response.headers.get("mcp-session-id") || undefined;
  await mcpPost(sessionId, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  return sessionId;
}
function toolResult(result) {
  assert.ok(result.body?.result, result.text);
  const content = result.body.result.content;
  assert.ok(Array.isArray(content) && content[0]?.text, result.text);
  return JSON.parse(content[0].text);
}
async function callTool(sessionId, name, args = {}) {
  return toolResult(await mcpPost(sessionId, { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }));
}
async function waitForOutput(sessionId, processId, pattern, timeoutMs = 20_000, initialOutput) {
  const deadline = Date.now() + timeoutMs;
  let output = initialOutput;
  if (pattern.test(output?.stdout || "")) return output;
  do {
    output = await callTool(sessionId, "read_output", { process_id: processId });
    if (pattern.test(output.stdout || "")) return output;
    await sleep(100);
  } while (Date.now() < deadline);
  return output;
}
async function readAllUntilExit(sessionId, first, timeoutMs = 20_000) {
  const processId = first.process_id;
  const deadline = Date.now() + timeoutMs;
  const pages = [];
  let stdout = "";
  let stderr = "";
  let output = first;
  do {
    if (output.output_page) {
      assert.equal(output.output_page.stdout_start, stdout.length, "stdout pages remain contiguous");
      assert.equal(output.output_page.stderr_start, stderr.length, "stderr pages remain contiguous");
      stdout += output.stdout || "";
      stderr += output.stderr || "";
      pages.push(output);
    } else if (!output.running) {
      stdout = output.stdout || "";
      stderr = output.stderr || "";
      pages.push(output);
    }
    if (!output.running && output.next_action !== "READ_SAME_PROCESS_ID") {
      return { pages, stdout, stderr, last: output };
    }
    output = await callTool(sessionId, "read_output", { process_id: processId, max_chars: 32_000 });
  } while (Date.now() < deadline);
  throw new Error(`process ${processId} did not reach a terminal output page within ${timeoutMs}ms`);
}

const sessionA = await initialize();
const getController = new AbortController();
const standaloneGet = await fetch(`${origin}/mcp`, {
  method: "GET",
  headers: { authorization: auth, accept: "text/event-stream", "mcp-protocol-version": "2025-06-18" },
  signal: getController.signal,
});
// Server is stateless POST-only (sessionIdGenerator: undefined); GET/SSE is optional in
// MCP Streamable HTTP. Contract is 405 + Allow: POST, asserted here so a regression to a
// silent 200/500 is caught.
if (standaloneGet.status !== 405) throw new Error(`GET /mcp expected 405, got ${standaloneGet.status} ${await standaloneGet.text()}`);
assert.equal(standaloneGet.headers.get("allow"), "POST");
getController.abort();
const listed = await mcpPost(sessionA, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const names = listed.body.result.tools.map((tool) => tool.name).sort();
assert.deepEqual(names, expectedTools);
const startProcessTool = listed.body.result.tools.find((tool) => tool.name === "start_process");
assert.equal(startProcessTool.inputSchema.properties.wait_ms.maximum, 10_000);
assert.equal(startProcessTool.inputSchema.properties.wait_ms.minimum, 0);
assert.deepEqual(startProcessTool.inputSchema.properties.activity_target.properties.type.enum, ["card", "node", "project"]);
assert.equal(startProcessTool.inputSchema.properties.activity_target.properties.id.maxLength, 160);
assert.equal(startProcessTool.inputSchema.properties.activity_target.properties.project.maxLength, 80);
assert.equal(startProcessTool.inputSchema.properties.action_class.maxLength, 64);
const invalidActivityTarget = await mcpPost(sessionA, { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: "start_process", arguments: { executable: process.execPath, args: ["-e", "process.stdout.write('INVALID_TARGET_MUST_NOT_RUN')"], activity_target: { type: "card", id: "bad id with spaces" } } } });
assert.equal(invalidActivityTarget.body?.result?.isError, true, invalidActivityTarget.text);
assert.match(invalidActivityTarget.body.result.content?.[0]?.text || "", /activity_target|invalid|validation/i);
const readOutputTool = listed.body.result.tools.find((tool) => tool.name === "read_output");
assert.equal(readOutputTool.inputSchema.properties.wait_ms.maximum, 10_000);
assert.equal(readOutputTool.inputSchema.properties.wait_ms.minimum, 0);
assert.equal(startProcessTool._meta, undefined, "start_process must stay widget/app metadata free over MCP transport");
assert.equal(readOutputTool._meta, undefined, "read_output must stay widget/app metadata free over MCP transport");
assert.ok(startProcessTool.inputSchema.properties.executable, "start_process must advertise structured executable input over MCP transport");
assert.ok(startProcessTool.inputSchema.properties.args, "start_process must advertise structured argv input over MCP transport");
assert.ok(startProcessTool.inputSchema.properties.stdin, "start_process must advertise structured stdin input over MCP transport");
assert.ok(startProcessTool.inputSchema.properties.env, "start_process must advertise structured env input over MCP transport");
assert.ok(startProcessTool.outputSchema?.properties?.failure_diagnostic, "start_process output must expose bounded machine-readable failure diagnostics");
assert.ok(startProcessTool.inputSchema.properties.script, "start_process must advertise structured script input over MCP transport");
assert.deepEqual(startProcessTool.inputSchema.properties.language.enum, ["powershell", "python", "node", "bash"]);
const startProcessPropertyOrder = Object.keys(startProcessTool.inputSchema.properties);
const legacyCommandExpected = (process.env.MCP_START_PROCESS_LEGACY_COMMAND_VISIBLE || "1").trim() !== "0";
assert.match(startProcessTool.inputSchema.properties.executable.description || "", /no shell re-parsing/i);
assert.match(startProcessTool.inputSchema.properties.script.description || "", /transported through stdin/i);
if (legacyCommandExpected) {
  assert.ok(startProcessPropertyOrder.indexOf("executable") < startProcessPropertyOrder.indexOf("command"), JSON.stringify(startProcessPropertyOrder));
  assert.ok(startProcessPropertyOrder.indexOf("script") < startProcessPropertyOrder.indexOf("command"), JSON.stringify(startProcessPropertyOrder));
  assert.match(startProcessTool.inputSchema.properties.command.description || "", /Legacy shell-command compatibility/i);
} else {
  assert.equal(startProcessTool.inputSchema.properties.command, undefined, JSON.stringify(startProcessPropertyOrder));
  assert.doesNotMatch(startProcessTool.description || "", /legacy command/i);
  const hiddenLegacyAttempt = await mcpPost(sessionA, { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: "start_process", arguments: { command: "Write-Output LEGACY_COMMAND_MUST_NOT_RUN" } } });
  assert.equal(hiddenLegacyAttempt.body?.result?.isError, true, hiddenLegacyAttempt.text);
  assert.match(hiddenLegacyAttempt.body.result.content?.[0]?.text || "", /command|Unrecognized key|validation/i);
}
const lossyCmdShimTransport = await mcpPost(sessionA, {
  jsonrpc: "2.0",
  id: Date.now(),
  method: "tools/call",
  params: { name: "start_process", arguments: { executable: "npm.cmd", args: ["line1\nline2"] } },
});
assert.equal(lossyCmdShimTransport.body?.result?.isError, true, lossyCmdShimTransport.text);
const lossyCmdShimText = lossyCmdShimTransport.body.result.content?.[0]?.text || "";
assert.match(lossyCmdShimText, /windows_command_shim_multiline_argument_not_lossless/);
assert.doesNotMatch(lossyCmdShimText, /\b(?:retry|try|prefer|use)\b/i, lossyCmdShimText);

const structuredTransport = await callTool(sessionA, "start_process", {
  executable: process.execPath,
  args: ["-e", "process.stdin.pipe(process.stdout)"],
  stdin: "MCPV4_STRUCTURED_OK\n",
  wait_ms: 10_000,
});
assert.equal(structuredTransport.exit_code, 0, JSON.stringify(structuredTransport));
assert.equal(structuredTransport.execution_mode, "native", JSON.stringify(structuredTransport));
assert.equal(structuredTransport.stdout, "MCPV4_STRUCTURED_OK\n", JSON.stringify(structuredTransport));
const structuredEnvTransport = await callTool(sessionA, "start_process", {
  executable: process.execPath,
  args: ["-e", "process.stdout.write(process.env.MCP_SMOKE_ENV || '')"],
  env: { MCP_SMOKE_ENV: "MCPV4_ENV_OK" },
  wait_ms: 10_000,
});
assert.equal(structuredEnvTransport.exit_code, 0, JSON.stringify(structuredEnvTransport));
assert.equal(structuredEnvTransport.stdout, "MCPV4_ENV_OK", JSON.stringify(structuredEnvTransport));
const scriptedTransport = await callTool(sessionA, "start_process", {
  language: "python",
  script: `import sys\nsys.stdout.write("MCPV4_SCRIPT_OK|'quote'|\\path")\n`,
  wait_ms: 10_000,
});
assert.equal(scriptedTransport.exit_code, 0, JSON.stringify(scriptedTransport));
assert.equal(scriptedTransport.execution_mode, "native", JSON.stringify(scriptedTransport));
assert.equal(scriptedTransport.execution_reason, "structured_script_python_stdin", JSON.stringify(scriptedTransport));
assert.equal(scriptedTransport.stdout, "MCPV4_SCRIPT_OK|'quote'|\\path", JSON.stringify(scriptedTransport));
const giantScriptPadding = Array.from({ length: 500 }, (_, index) => `# structured-padding-${index}-\"quote\"-$env:TEMP-{json}`).join("\n");
const giantPowerShellScript = `${giantScriptPadding}\n$pythonSource = @'\nimport sys\nsys.stdout.write(\"GIANT_ONE_CALL|$env:TEMP|'quote'|{json}|\\\\path\")\n'@\n$pythonSource | python -\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n[Console]::Out.Write("|PS_DONE")\n`;
const giantStructuredTransport = await callTool(sessionA, "start_process", { language: "powershell", script: giantPowerShellScript, wait_ms: 10_000 });
assert.equal(giantStructuredTransport.execution_outcome, "success", JSON.stringify(giantStructuredTransport));
assert.equal(giantStructuredTransport.exit_code, 0, JSON.stringify(giantStructuredTransport));
assert.equal(giantStructuredTransport.stdout.replace(/\r\n/g, "\n"), "GIANT_ONE_CALL|$env:TEMP|'quote'|{json}|\\path|PS_DONE", JSON.stringify(giantStructuredTransport));
assert.equal(giantStructuredTransport.execution_reason, "structured_script_powershell_stdin_scriptblock", JSON.stringify(giantStructuredTransport));
const giantScriptBenchCount = Math.max(0, Number(process.env.MCP_SMOKE_GIANT_SCRIPT_COUNT || 0));
if (giantScriptBenchCount > 0) {
  const giantLatencies = [];
  for (let index = 0; index < giantScriptBenchCount; index += 1) {
    const marker = `GIANT_BENCH_${index}|$env:TEMP|'quote'|{json}|\\path`;
    const script = `${giantScriptPadding}\n$payload = @'\n${marker}\n'@\n[Console]::Out.Write($payload)\n`;
    const startedAt = performance.now();
    const result = await callTool(sessionA, "start_process", { language: "powershell", script, wait_ms: 10_000 });
    giantLatencies.push(performance.now() - startedAt);
    assert.equal(result.execution_outcome, "success", JSON.stringify({ index, result }));
    assert.equal(result.exit_code, 0, JSON.stringify({ index, result }));
    assert.equal(result.stdout.replace(/\r\n/g, "\n"), marker, JSON.stringify({ index, result }));
    assert.equal(result.execution_reason, "structured_script_powershell_stdin_scriptblock", JSON.stringify({ index, result }));
  }
  const sorted = [...giantLatencies].sort((left, right) => left - right);
  const pct = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
  console.log(`AUTHENTICATED_GIANT_SCRIPT_BENCH ${JSON.stringify({
    oauth_bypassed: false,
    calls: giantScriptBenchCount,
    script_padding_lines: 500,
    failures: 0,
    avoidable_first_attempt_failures: 0,
    p50_ms: Number(pct(0.50).toFixed(3)),
    p95_ms: Number(pct(0.95).toFixed(3)),
    max_ms: Number((sorted.at(-1) ?? 0).toFixed(3)),
  })}`);
}
const expectedPythonFailure = await callTool(sessionA, "start_process", {
  language: "python",
  script: "raise SystemExit(9)\n",
  wait_ms: 10_000,
});
assert.equal(expectedPythonFailure.execution_outcome, "nonzero_exit", JSON.stringify(expectedPythonFailure));
assert.equal(expectedPythonFailure.exit_code, 9, JSON.stringify(expectedPythonFailure));
const expectedNodeFailure = await callTool(sessionA, "start_process", {
  language: "node",
  script: "process.exit(11);\n",
  wait_ms: 10_000,
});
assert.equal(expectedNodeFailure.execution_outcome, "nonzero_exit", JSON.stringify(expectedNodeFailure));
assert.equal(expectedNodeFailure.exit_code, 11, JSON.stringify(expectedNodeFailure));
const expectedPowerShellFailure = await callTool(sessionA, "start_process", {
  language: "powershell",
  script: "Write-Error 'EXPECTED_NONZERO'; exit 7",
  wait_ms: 10_000,
});
assert.equal(expectedPowerShellFailure.execution_outcome, "nonzero_exit", JSON.stringify(expectedPowerShellFailure));
assert.equal(expectedPowerShellFailure.exit_code, 7, JSON.stringify(expectedPowerShellFailure));
const invalidPowerShellSyntax = await callTool(sessionA, "start_process", {
  language: "powershell",
  script: "if (",
  wait_ms: 10_000,
});
assert.equal(invalidPowerShellSyntax.execution_outcome, "nonzero_exit", JSON.stringify(invalidPowerShellSyntax));
assert.notEqual(invalidPowerShellSyntax.exit_code, 0, JSON.stringify(invalidPowerShellSyntax));
assert.match(invalidPowerShellSyntax.stderr || "", /Missing condition|parse|if statement/i, JSON.stringify(invalidPowerShellSyntax));
assert.deepEqual(invalidPowerShellSyntax.failure_diagnostic, { kind: "parser_error", origin: "powershell", boundary: "source" }, JSON.stringify(invalidPowerShellSyntax));
assert.equal(expectedPythonFailure.failure_diagnostic, undefined, JSON.stringify(expectedPythonFailure));
const missingExecutableFailure = await callTool(sessionA, "start_process", {
  executable: "__mcp_definitely_missing_executable__",
  args: [],
  wait_ms: 10_000,
});
assert.equal(missingExecutableFailure.execution_outcome, "error", JSON.stringify(missingExecutableFailure));
assert.equal(missingExecutableFailure.error_code, "ENOENT", JSON.stringify(missingExecutableFailure));
assert.deepEqual(missingExecutableFailure.failure_diagnostic, { kind: "spawn_error", origin: "process", boundary: "spawn", code: "ENOENT" }, JSON.stringify(missingExecutableFailure));

const authBenchCount = Math.max(0, Number(process.env.MCP_SMOKE_BENCH_COUNT || 0));
if (authBenchCount > 0) {
  const percentile = (values, ratio) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
  };
  const summarize = (values) => ({
    n: values.length,
    p50_ms: Number(percentile(values, 0.50).toFixed(3)),
    p95_ms: Number(percentile(values, 0.95).toFixed(3)),
    avg_ms: Number((values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)).toFixed(3)),
    min_ms: Number(Math.min(...values).toFixed(3)),
    max_ms: Number(Math.max(...values).toFixed(3)),
  });
  const startLatencies = [];
  const readLatencies = [];
  for (let index = 0; index < authBenchCount; index += 1) {
    const marker = `AUTH_MCP_${index}`;
    const startAt = performance.now();
    const started = await callTool(sessionA, "start_process", {
      executable: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(marker)})`],
      wait_ms: 10_000,
    });
    startLatencies.push(performance.now() - startAt);
    assert.equal(started.execution_outcome, "success", JSON.stringify(started));
    assert.equal(started.exit_code, 0, JSON.stringify(started));
    assert.equal(started.stdout, marker, JSON.stringify(started));
    const readAt = performance.now();
    const read = await callTool(sessionA, "read_output", { process_id: started.process_id, wait_ms: 0 });
    readLatencies.push(performance.now() - readAt);
    assert.equal(read.execution_outcome, "success", JSON.stringify(read));
    assert.equal(read.stdout, marker, JSON.stringify(read));
  }
  console.log(`AUTHENTICATED_MCP_BENCH ${JSON.stringify({
    oauth_bypassed: false,
    calls: { start_process: authBenchCount, read_output: authBenchCount },
    start_process: summarize(startLatencies),
    read_output: summarize(readLatencies),
  })}`);
}

const knownSignatureCount = Math.max(0, Number(process.env.MCP_SMOKE_KNOWN_SIGNATURE_COUNT || 0));
if (knownSignatureCount > 0) {
  const latencies = [];
  const modes = { structured_argv: 0, python_script: 0, powershell_script: 0, node_script: 0, observation_script: 0 };
  for (let index = 0; index < knownSignatureCount; index += 1) {
    const kind = index % 5;
    let args;
    let expectedStdout;
    let expectedReason;
    if (kind === 0) {
      expectedStdout = `KNOWN_ARGV_${index}|$env:TEMP|'literal'`;
      args = { executable: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(expectedStdout)})`], wait_ms: 10_000 };
      expectedReason = "structured_argv";
      modes.structured_argv += 1;
    } else if (kind === 1) {
      expectedStdout = `KNOWN_PY_SCRIPT_${index}|$env:TEMP|'literal'|{json}`;
      args = { language: "python", script: `import sys\nsys.stdout.write(${JSON.stringify(expectedStdout)})\n`, wait_ms: 10_000 };
      expectedReason = "structured_script_python_stdin";
      modes.python_script += 1;
    } else if (kind === 2) {
      expectedStdout = `KNOWN_PS_SCRIPT_${index}|$env:TEMP|'literal'|{json}`;
      args = { language: "powershell", script: `$payload = @'\n${expectedStdout}\n'@\n[Console]::Out.Write($payload)\n`, wait_ms: 10_000 };
      expectedReason = "structured_script_powershell_stdin_scriptblock";
      modes.powershell_script += 1;
    } else if (kind === 3) {
      expectedStdout = `KNOWN_NODE_SCRIPT_${index}|$env:TEMP|\"quote\"|\\path`;
      args = { language: "node", script: `process.stdout.write(${JSON.stringify(expectedStdout)});\n`, wait_ms: 10_000 };
      expectedReason = "structured_script_node_stdin";
      modes.node_script += 1;
    } else {
      expectedStdout = "";
      args = { language: "powershell", script: `Get-Command __mcp_known_missing_${index}__ -ErrorAction SilentlyContinue | Out-Null\n[Console]::Out.Write('')\n`, wait_ms: 10_000 };
      expectedReason = "structured_script_powershell_stdin_scriptblock";
      modes.observation_script += 1;
    }
    const started = performance.now();
    const result = await callTool(sessionA, "start_process", args);
    latencies.push(performance.now() - started);
    assert.equal(result.execution_outcome, "success", JSON.stringify({ index, kind, result }));
    assert.equal(result.exit_code, 0, JSON.stringify({ index, kind, result }));
    assert.equal(result.stdout.replace(/\r\n/g, "\n"), expectedStdout.replace(/\r\n/g, "\n"), JSON.stringify({ index, kind, result }));
    assert.equal(result.execution_reason, expectedReason, JSON.stringify({ index, kind, result }));
  }
  const sorted = [...latencies].sort((left, right) => left - right);
  const pct = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
  console.log(`AUTHENTICATED_KNOWN_SIGNATURE_BENCH ${JSON.stringify({
    oauth_bypassed: false,
    calls: knownSignatureCount,
    failures: 0,
    avoidable_first_attempt_failures: 0,
    avoidable_first_attempt_failure_rate_pct: 0,
    modes,
    p50_ms: Number(pct(0.50).toFixed(3)),
    p95_ms: Number(pct(0.95).toFixed(3)),
    max_ms: Number((sorted.at(-1) ?? 0).toFixed(3)),
  })}`);
}

const historicalPythonTransportCount = Math.max(0, Number(process.env.MCP_SMOKE_HISTORICAL_PYTHON_COUNT || 0));
if (historicalPythonTransportCount > 0) {
  const latencies = [];
  const variants = { json_object: 0, powershell_literal: 0, cpp_literal: 0, markdown_literal: 0, regex_multiline: 0 };
  const payloads = ["[{\"path\":\"C:\\Users\\Example\\AppData\\Local\\ChatGPTMcpMinimal\\.state\\transport.jsonl\",\"exists\":false,\"size\":null,\"mtime\":null},{\"path\":\"C:\\Users\\Example\\minimal-connectors\\clone-a\\transport.jsonl\",\"exists\":true,\"size\":12345}]", "$mcpLine = @($text -split \"`r?`n\" | Where-Object { $_ -match '^- Keep MCPv3 start_process payloads short' }); if ($mcpLine.Count -ne 1) { throw \"found $($mcpLine.Count)\" }", "TEXT(\"VICTORY  |  YOUR TEAM %d  |  ENEMY CORE DESTROYED\\n%s\") => TEXT(\"DEFEAT  |  ENEMY TEAM %d WINS  |  YOUR CORE DESTROYED\\n%s\"); path=Plugins/P3/P3UI/Source/P3UI/Private/P3LaneWarHUDWidget.cpp", "Every peer-recovery check is recorded in the acting worker's report. Each run emits one explicit `Peer recovery:` entry in `findings`: either `none needed`, `scheduler control unavailable: <reason>`, or the action taken.", "cleanup_converger|timeline_materializer|worktree\\s+(remove|prune)|branch\\s+(-d|-D|--delete)|update-ref\\s+-d|git\\s+clean|gh\\s+pr\\s+merge|Remove-Item|memory_bank\\.py\\s+record|\\.agents\nsecond-line\twith-tab\nand\\slashes"];  const variantNames = Object.keys(variants);
  for (let index = 0; index < historicalPythonTransportCount; index += 1) {
    const variantIndex = index % payloads.length;
    const payload = payloads[variantIndex];
    const marker = `HISTORICAL_PYTHON_${index}`;
    variants[variantNames[variantIndex]] += 1;
    const script = `import sys\npayload = ${JSON.stringify(payload)}\nsys.stdout.write(${JSON.stringify(marker)} + "|" + payload)\n`;
    const startedAt = performance.now();
    const result = await callTool(sessionA, "start_process", { language: "python", script, wait_ms: 10_000 });
    latencies.push(performance.now() - startedAt);
    assert.equal(result.execution_outcome, "success", JSON.stringify({ index, variant: variantNames[variantIndex], result }));
    assert.equal(result.exit_code, 0, JSON.stringify({ index, variant: variantNames[variantIndex], result }));
    assert.equal(result.execution_reason, "structured_script_python_stdin", JSON.stringify({ index, result }));
    assert.equal(result.stdout.replace(/\r\n/g, "\n"), `${marker}|${payload}`.replace(/\r\n/g, "\n"), JSON.stringify({ index, variant: variantNames[variantIndex], result }));
  }
  const sorted = [...latencies].sort((left, right) => left - right);
  const pct = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
  console.log(`AUTHENTICATED_HISTORICAL_PYTHON_TRANSPORT_BENCH ${JSON.stringify({
    oauth_bypassed: false,
    calls: historicalPythonTransportCount,
    failures: 0,
    avoidable_first_attempt_failures: 0,
    variants,
    p50_ms: Number(pct(0.50).toFixed(3)),
    p95_ms: Number(pct(0.95).toFixed(3)),
    max_ms: Number((sorted.at(-1) ?? 0).toFixed(3)),
  })}`);
}

const scriptMatrixCount = Math.max(0, Number(process.env.MCP_SMOKE_SCRIPT_MATRIX_COUNT || 0));
if (scriptMatrixCount > 0) {
  const latencies = [];
  const modes = { python: 0, node: 0, powershell: 0 };
  for (let index = 0; index < scriptMatrixCount; index += 1) {
    const kind = index % 3;
    const variant = Math.floor(index / 3) % 4;
    const bodies = [
      `MATRIX_${index}|$env:TEMP|'single'|"double"|{json}|\\path`,
      `MATRIX_${index}|unicode=äö漢字🙂|percent=%TEMP%|dollar=$HOME`,
      `MATRIX_${index}|line1\nline2|tabs=\t|brackets=[]{}()`,
      `MATRIX_${index}|backtick=\`|amp=&|pipe=||doublepipe=||semicolon=;`,
    ];
    const body = bodies[variant];
    let language;
    let script;
    if (kind === 0) {
      language = "python";
      script = `import sys\nsys.stdout.write(${JSON.stringify(body)})\n`;
      modes.python += 1;
    } else if (kind === 1) {
      language = "node";
      script = `process.stdout.write(${JSON.stringify(body)});\n`;
      modes.node += 1;
    } else {
      language = "powershell";
      script = `$payload = @'\n${body}\n'@\n[Console]::Out.Write($payload)\n`;
      modes.powershell += 1;
    }
    const startedAt = performance.now();
    const result = await callTool(sessionA, "start_process", { language, script, wait_ms: 10_000 });
    latencies.push(performance.now() - startedAt);
    assert.equal(result.execution_outcome, "success", JSON.stringify({ index, language, result }));
    assert.equal(result.exit_code, 0, JSON.stringify({ index, language, result }));
    assert.equal(result.stdout.replace(/\r\n/g, "\n"), body.replace(/\r\n/g, "\n"), JSON.stringify({ index, language, result }));
    assert.match(result.execution_reason || "", /^structured_script_/);
  }
  const sorted = [...latencies].sort((left, right) => left - right);
  const pct = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
  console.log(`AUTHENTICATED_SCRIPT_MATRIX ${JSON.stringify({
    oauth_bypassed: false,
    calls: scriptMatrixCount,
    failures: 0,
    modes,
    p50_ms: Number(pct(0.50).toFixed(3)),
    p95_ms: Number(pct(0.95).toFixed(3)),
    max_ms: Number((sorted.at(-1) ?? 0).toFixed(3)),
  })}`);
}

const scriptBenchCount = Math.max(0, Number(process.env.MCP_SMOKE_SCRIPT_BENCH_COUNT || 0));
if (scriptBenchCount > 0) {
  const latencies = [];
  for (let index = 0; index < scriptBenchCount; index += 1) {
    const marker = `SCRIPT_BENCH_${index}|$env:TEMP|'quote'|\\path|{json}`;
    const startedAt = performance.now();
    const result = await callTool(sessionA, "start_process", {
      language: "python",
      script: `import sys\nsys.stdout.write(${JSON.stringify(marker)})\n`,
      wait_ms: 10_000,
    });
    latencies.push(performance.now() - startedAt);
    assert.equal(result.execution_outcome, "success", JSON.stringify(result));
    assert.equal(result.exit_code, 0, JSON.stringify(result));
    assert.equal(result.stdout, marker, JSON.stringify(result));
    assert.equal(result.execution_reason, "structured_script_python_stdin", JSON.stringify(result));
  }
  const sorted = [...latencies].sort((left, right) => left - right);
  const pct = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
  console.log(`AUTHENTICATED_SCRIPT_BENCH ${JSON.stringify({
    oauth_bypassed: false,
    calls: scriptBenchCount,
    failures: 0,
    p50_ms: Number(pct(0.50).toFixed(3)),
    p95_ms: Number(pct(0.95).toFixed(3)),
    max_ms: Number((sorted.at(-1) ?? 0).toFixed(3)),
  })}`);
}

const startedAt = Date.now();
let jobOne;
let jobTwo;
let treeJob;
let floodJob;
try {
  jobOne = await callTool(sessionA, "start_process", { language: "powershell", script: "1..20 | ForEach-Object { Write-Output ('JOB_ONE_' + $_); Start-Sleep -Milliseconds 200 }", activity_target: { type: "card", id: "smoke-activity-target", project: "nexus" }, action_class: "smoke" });
  assert.ok(jobOne.process_id && Date.now() - startedAt < 5000);
  assert.equal(jobOne.running, true);
  const outputOne = await waitForOutput(sessionA, jobOne.process_id, /JOB_ONE_/, 20_000, jobOne);
  assert.equal(outputOne.running, true);
  assert.deepEqual(outputOne.activity_target, { type: "card", id: "smoke-activity-target", project: "nexus" });
  assert.equal(outputOne.action_class, "smoke");
  assert.match(outputOne.stdout, /JOB_ONE_/, JSON.stringify({
    running: outputOne.running,
    exit_code: outputOne.exit_code,
    signal: outputOne.signal,
    stderr: outputOne.stderr,
    error: outputOne.error,
  }));

  jobTwo = await callTool(sessionA, "start_process", { language: "powershell", script: "1..20 | ForEach-Object { Write-Output ('JOB_TWO_' + $_); Start-Sleep -Milliseconds 200 }" });
  assert.ok(jobTwo.process_id && jobTwo.process_id !== jobOne.process_id);
  const [readOne, readTwo] = await Promise.all([
    callTool(sessionA, "read_output", { process_id: jobOne.process_id }),
    callTool(sessionA, "read_output", { process_id: jobTwo.process_id }),
  ]);
  assert.equal(readOne.running, true);
  assert.equal(readTwo.running, true);

  treeJob = await callTool(sessionA, "start_process", { language: "powershell", script: "$child = Start-Process -FilePath \"$env:SystemRoot\\System32\\ping.exe\" -ArgumentList @('-t','127.0.0.1') -WindowStyle Hidden -PassThru; Write-Output ('CHILD_PID=' + $child.Id); Wait-Process -Id $child.Id" });
  const treeOutput = await waitForOutput(sessionA, treeJob.process_id, /CHILD_PID=(\d+)/, 20_000, treeJob);
  const childPid = Number(treeOutput.stdout.match(/CHILD_PID=(\d+)/)?.[1]);
  assert.ok(childPid > 0, treeOutput.stdout);
  const killed = await callTool(sessionA, "kill_process", { process_id: treeJob.process_id });
  assert.equal(killed.killed, true);
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `if (Get-Process -Id ${childPid} -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }`], { encoding: "utf8" });

  floodJob = await callTool(sessionA, "start_process", { language: "powershell", script: "$payload = 'X' * 200; 1..10000 | ForEach-Object { Write-Output (('FLOOD_{0}_{1}' -f $_,$payload)) }" });
  const healthStarted = Date.now();
  const healthDuringFlood = await jsonFetch(`${origin}/health`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(healthDuringFlood.response.status, 200, healthDuringFlood.text);
  assert.ok(Date.now() - healthStarted < 5_000, "health probe stalled during high-output process");
  const floodOutput = await readAllUntilExit(sessionA, floodJob);
  assert.equal(floodOutput.last.running, false);
  assert.ok(floodOutput.pages[0].stdout.length > 30_000 && floodOutput.pages[0].stdout.length <= 32_000, `first paged read_output returned ${floodOutput.pages[0].stdout.length} characters`);
  assert.equal(floodOutput.pages.at(-1).stdout_truncated, true);
  assert.equal(floodOutput.stdout.length, 100_000, `lossless retained output returned ${floodOutput.stdout.length} characters`);
  assert.match(floodOutput.stdout, /FLOOD_10000_/);

  if (toolProfile === "full") {
  const sessionB = await initialize();
  const scope = `smoke-exact-scope-${Date.now()}`;
  const claimA = await callTool(sessionA, "busy_claim", { actor: "smoke-actor-a", scope });
  assert.equal(claimA.ok, true);
  const claimB = await callTool(sessionB, "busy_claim", { actor: "smoke-actor-b", scope });
  assert.equal(claimB.ok, false);
  assert.equal(claimB.reason, "scope_already_claimed");
  const listedBusy = await callTool(sessionB, "busy_list");
  assert.ok(listedBusy.claims.some((claim) => claim.actor === "smoke-actor-a" && claim.scope === scope));
  const wrongRelease = await callTool(sessionB, "busy_release", { actor: "smoke-actor-b", scope });
  assert.equal(wrongRelease.ok, false);
  const released = await callTool(sessionA, "busy_release", { actor: "smoke-actor-a", scope });
  assert.equal(released.ok, true);
  const afterRelease = await callTool(sessionB, "busy_list");
  assert.ok(!afterRelease.claims.some((claim) => claim.scope === scope));
  }
} finally {
  if (jobOne?.process_id) await callTool(sessionA, "kill_process", { process_id: jobOne.process_id }).catch(() => undefined);
  if (jobTwo?.process_id) await callTool(sessionA, "kill_process", { process_id: jobTwo.process_id }).catch(() => undefined);
  if (treeJob?.process_id) await callTool(sessionA, "kill_process", { process_id: treeJob.process_id }).catch(() => undefined);
  if (floodJob?.process_id) await callTool(sessionA, "kill_process", { process_id: floodJob.process_id }).catch(() => undefined);
}

const smokePort = Number(new URL(origin).port || (new URL(origin).protocol === "https:" ? 443 : 80));
const listenerJson = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-NetTCPConnection -LocalPort ${smokePort} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress`], { encoding: "utf8" }).trim();
assert.ok(listenerJson, `smoke origin port ${smokePort} has no listener`);
const port9121 = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "if (Get-NetTCPConnection -LocalPort 9121 -State Listen -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"], { encoding: "utf8" });
assert.equal(port9121, "");
const processJson = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8" });
const processes = JSON.parse(processJson);
const processList = Array.isArray(processes) ? processes : [processes];
const hasSerenaProcess = processList.some((process) => {
  const name = String(process.Name || "").toLowerCase();
  const commandLine = String(process.CommandLine || "");
  const directBinary = /^serena(?:\.exe)?$/.test(name);
  const launcher = /^(?:uvx?|python(?:3)?)(?:\.exe)?$/.test(name);
  return directBinary || (launcher && /\bserena\b/i.test(commandLine) && /\bstart-mcp-server\b/i.test(commandLine));
});
assert.ok(!hasSerenaProcess, "Serena process exists");
const busySmoke = toolProfile === "full" ? "cross_session_claim_list_release" : "outside_process_profile";
console.log(`PASS mcp=standard-initialize tools=${names.join(",")} background=immediate+read_while_running concurrency=two_jobs high_output=bounded+health-responsive kill_tree=root+child_gone busy=${busySmoke} listener=${listenerJson} port9121=unused serena=absent`);
