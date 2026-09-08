// Stress harness for shell-mcp.
// Usage: node scripts/stress.mjs
// Env knobs: STRESS_BURST, STRESS_SUSTAINED, STRESS_CONCURRENCY, STRESS_PROCS
//
// Exercises the stateless /mcp path under concurrency and abuse, then checks for
// leaked in-flight requests and RSS growth. Exits non-zero on any failure.

import "dotenv/config";
import { execFileSync } from "node:child_process";

// Requests go straight to loopback so we measure the server, not the Tailscale funnel.
// The OAuth `resource` must still be the public origin: the server binds its protected
// resource to new URL("/mcp", MCP_PUBLIC_ORIGIN), and a mismatched resource is refused
// with invalid_grant at the token exchange.
const origin = (process.env.MCP_SMOKE_ORIGIN || "http://127.0.0.1:3000").replace(/\/$/, "");
const publicOrigin = (process.env.MCP_PUBLIC_ORIGIN || origin).replace(/\/$/, "");
const ownerLogin = (process.env.TAILSCALE_OWNER_LOGIN || "owner@example.com").trim();
const redirectUri = "https://chatgpt.com/connector/oauth/stress";
const resource = `${publicOrigin}/mcp`;

const BURST = Number(process.env.STRESS_BURST || 100);
const SUSTAINED = Number(process.env.STRESS_SUSTAINED || 400);
const CONCURRENCY = Number(process.env.STRESS_CONCURRENCY || 25);
const PROCS = Number(process.env.STRESS_PROCS || 12);

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body, text };
}

// ---------- auth ----------
const registration = await jsonFetch(`${origin}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "shell-mcp-stress",
  }),
});
if (registration.response.status !== 201) throw new Error(`register failed: ${registration.text}`);
const client = registration.body;

const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd";
const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
const authorizationUrl = new URL(`${origin}/authorize`);
for (const [key, value] of Object.entries({
  response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
  code_challenge: challenge, code_challenge_method: "S256", resource,
  scope: "mcp offline_access", state: "shell-mcp-stress",
})) authorizationUrl.searchParams.set(key, value);
const authorization = await fetch(authorizationUrl, { redirect: "manual", headers: { "tailscale-user-login": ownerLogin } });
if (authorization.status !== 302) throw new Error(`authorize failed: ${authorization.status}`);
const code = new URL(authorization.headers.get("location")).searchParams.get("code");

const token = await jsonFetch(`${origin}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code", client_id: client.client_id, code,
    redirect_uri: redirectUri, code_verifier: verifier, resource,
  }),
});
if (token.response.status !== 200) throw new Error(`token failed: ${token.text}`);
const auth = `Bearer ${token.body.access_token}`;

const H = {
  authorization: auth,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
};

async function mcpPost(message, extraHeaders = {}) {
  const started = performance.now();
  const r = await jsonFetch(`${origin}/mcp`, {
    method: "POST", headers: { ...H, ...extraHeaders }, body: JSON.stringify(message),
  });
  let body = r.body;
  if (typeof body === "string" && r.response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = [...r.text.matchAll(/^data:\s*(.+)$/gm)].at(-1)?.[1];
    if (data) body = JSON.parse(data);
  }
  return { status: r.response.status, body, text: r.text, ms: performance.now() - started };
}

const health = async () => (await jsonFetch(`${origin}/health`)).body;
function rssMb(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const ws = execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: "utf8" }).trim();
    return Math.round(Number(ws) / 1048576 * 10) / 10;
  } catch { return null; }
}

function pct(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10;
}
function report(label, lats, errors) {
  console.log(`  ${label}: n=${lats.length} err=${errors} p50=${pct(lats, 0.5)}ms p95=${pct(lats, 0.95)}ms p99=${pct(lats, 0.99)}ms max=${pct(lats, 1)}ms`);
}
async function pool(total, concurrency, task) {
  const lats = []; let errors = 0; let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (true) {
      const i = next++;
      if (i >= total) return;
      try {
        const r = await task(i);
        if (r.ok) lats.push(r.ms); else { errors++; if (errors <= 3) console.log(`     err: ${r.detail}`); }
      } catch (e) { errors++; if (errors <= 3) console.log(`     throw: ${e.message}`); }
    }
  }));
  return { lats, errors };
}

const listCall = () => ({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

const baselineHealth = await health();
const baselineRss = rssMb(Number(baselineHealth.pid));
console.log(`baseline: rss=${baselineRss}MB active=${baselineHealth.active_requests} total=${baselineHealth.total_requests}\n`);

// ---------- phase 1: burst ----------
console.log(`phase 1 - burst ${BURST} concurrent tools/list`);
{
  const started = performance.now();
  const { lats, errors } = await pool(BURST, BURST, async () => {
    const r = await mcpPost(listCall());
    const good = r.status === 200 && Array.isArray(r.body?.result?.tools);
    return { ok: good, ms: r.ms, detail: `status=${r.status} ${String(r.text).slice(0, 120)}` };
  });
  report("burst", lats, errors);
  console.log(`  wall=${Math.round(performance.now() - started)}ms`);
  if (errors) fail(`burst had ${errors} errors`); else ok("burst clean");
}

// ---------- phase 2: sustained ----------
console.log(`\nphase 2 - sustained ${SUSTAINED} req @ concurrency ${CONCURRENCY}`);
{
  const started = performance.now();
  const { lats, errors } = await pool(SUSTAINED, CONCURRENCY, async () => {
    const r = await mcpPost(listCall());
    return { ok: r.status === 200 && !!r.body?.result, ms: r.ms, detail: `status=${r.status}` };
  });
  report("sustained", lats, errors);
  const wall = performance.now() - started;
  console.log(`  wall=${Math.round(wall)}ms throughput=${Math.round(SUSTAINED / (wall / 1000))} req/s`);
  if (errors) fail(`sustained had ${errors} errors`); else ok("sustained clean");
}

// ---------- phase 3: concurrent background processes ----------
console.log(`\nphase 3 - ${PROCS} concurrent start_process/read_output/kill_process jobs`);
{
  const jobs = [];
  const { lats, errors } = await pool(PROCS, PROCS, async (i) => {
    const r = await mcpPost({
      jsonrpc: "2.0", id: 100 + i, method: "tools/call",
      params: { name: "start_process", arguments: { command: `Write-Output 'STRESS_${i}'; Start-Sleep -Seconds 20` } },
    });
    const text = r.body?.result?.content?.[0]?.text || "";
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (r.status === 200 && data?.process_id) jobs[i] = data;
    return { ok: r.status === 200 && !!data?.process_id, ms: r.ms, detail: `status=${r.status} ${text.slice(0, 120)}` };
  });
  report("start_process", lats, errors);
  if (errors) fail(`start_process had ${errors} errors`);

  const activeJobs = jobs.map((job, index) => job ? { job, index } : null).filter(Boolean);
  const outputs = await Promise.all(activeJobs.map(({ job }) => mcpPost({
    jsonrpc: "2.0", id: 200 + job.pid, method: "tools/call",
    params: { name: "read_output", arguments: { process_id: job.process_id } },
  })));
  const outputErrors = outputs.filter((r, i) => r.status !== 200 || !String(r.body?.result?.content?.[0]?.text || "").includes(`STRESS_${activeJobs[i].index}`)).length;
  if (outputErrors) fail(`read_output had ${outputErrors} errors`); else ok("read_output clean, all outputs matched");

  const kills = await Promise.all(activeJobs.map(({ job }) => mcpPost({
    jsonrpc: "2.0", id: 300 + job.pid, method: "tools/call",
    params: { name: "kill_process", arguments: { process_id: job.process_id } },
  })));
  const killErrors = kills.filter((r) => r.status !== 200 || !r.body?.result?.content?.[0]?.text?.includes("killed")).length;
  if (killErrors) fail(`kill_process had ${killErrors} errors`); else ok("kill_process clean, all process trees stopped");
}

// ---------- phase 4: abuse ----------
console.log(`\nphase 4 - abuse / malformed input`);
{
  const noAuth = await fetch(`${origin}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(listCall()) });
  noAuth.status === 401 ? ok(`unauthenticated -> 401`) : fail(`unauthenticated -> ${noAuth.status}, expected 401`);

  const badTok = await fetch(`${origin}/mcp`, { method: "POST", headers: { ...H, authorization: "Bearer garbage" }, body: JSON.stringify(listCall()) });
  badTok.status === 401 ? ok(`bad token -> 401`) : fail(`bad token -> ${badTok.status}, expected 401`);

  const malformed = await fetch(`${origin}/mcp`, { method: "POST", headers: H, body: "{not json" });
  malformed.status >= 400 && malformed.status < 500 ? ok(`malformed JSON -> ${malformed.status}`) : fail(`malformed JSON -> ${malformed.status}, expected 4xx`);

  const oversize = await fetch(`${origin}/mcp`, { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(5 * 1024 * 1024) } }) }).catch((e) => ({ status: `threw:${e.message}` }));
  oversize.status === 413 ? ok(`5MB body -> 413 (limit enforced)`) : fail(`5MB body -> ${oversize.status}, expected 413`);

  const unknown = await mcpPost({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "no_such_tool", arguments: {} } });
  unknown.body?.error || unknown.body?.result?.isError ? ok(`unknown tool -> JSON-RPC error`) : fail(`unknown tool -> unexpected: ${unknown.text.slice(0, 200)}`);

  const getMcp = await fetch(`${origin}/mcp`, { method: "GET", headers: H });
  getMcp.status === 405 ? ok(`GET /mcp -> 405`) : fail(`GET /mcp -> ${getMcp.status}, expected 405`);
}

// ---------- phase 5: leak check ----------
console.log(`\nphase 5 - settle & leak check`);
await new Promise((r) => setTimeout(r, 3000));
{
  const after = await health();
  const afterRss = rssMb(Number(after.pid));
  console.log(`  active_requests=${after.active_requests} total_requests=${after.total_requests} rss=${afterRss}MB (baseline ${baselineRss}MB)`);
  after.active_requests === 0 ? ok("no leaked in-flight requests") : fail(`active_requests=${after.active_requests}, expected 0`);
  if (baselineRss && afterRss) {
    const delta = afterRss - baselineRss;
    console.log(`  rss delta=${Math.round(delta * 10) / 10}MB`);
    delta < 150 ? ok(`rss growth bounded (+${Math.round(delta)}MB)`) : fail(`rss grew +${Math.round(delta)}MB`);
  }
  const still = await mcpPost(listCall());
  still.status === 200 ? ok("server still healthy after stress") : fail(`server unhealthy after stress: ${still.status}`);
}

console.log(`\n${failures.length ? `STRESS FAILED (${failures.length})\n- ${failures.join("\n- ")}` : "STRESS PASSED"}`);
process.exit(failures.length ? 1 : 0);
