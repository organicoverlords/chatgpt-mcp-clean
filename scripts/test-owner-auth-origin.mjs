import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
async function unusedPort() {
  return await new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}
async function waitHealth(origin, port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) {
        const body = await response.json();
        if (body.status === "ok" && body.port === port) return body;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error(`owner-auth test server health timeout: ${origin}`);
}
async function localRequest(origin, path, { method = "GET", host, headers = {}, body = null } = {}) {
  return await new Promise((resolveRequest, reject) => {
    const request = httpRequest(new URL(path, origin), { method, headers: { ...(host ? { Host: host } : {}), ...headers } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolveRequest({ status: response.statusCode ?? 0, headers: response.headers, text }));
    });
    request.once("error", reject);
    if (body != null) request.write(body);
    request.end();
  });
}
async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, text, body };
}

const temporary = mkdtempSync(join(tmpdir(), "mcp-owner-auth-origin-"));
const port = await unusedPort();
const origin = `http://127.0.0.1:${port}`;
const publicOrigin = "https://public-owner-auth.test";
const ownerAuthOrigin = "https://owner-only.test.ts.net";
const ownerLogin = "owner@example.com";
const redirectUri = "https://chatgpt.com/connector/oauth/owner-auth-test";
const resource = `${publicOrigin}/mcp`;
const server = spawn(process.execPath, [resolve("dist/index.js")], {
  cwd: resolve("."),
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    MCP_BACKEND_MODE: "1",
    MCP_WIREGUARD_CANDIDATE: "0",
    MCP_FORCE_CONNECTION_CLOSE: "0",
    MCP_FRONT_DOOR_HOST: "127.0.0.1:3003",
    MCP_RUNTIME_INSTANCE_ID: "",
    MCP_RUNTIME_SOURCE_COMMIT: "",
    MCP_RUNTIME_DIST_SHA256: "",
    MCP_RUNTIME_SOURCE_DIRTY: "",
    MCP_TOOL_PROFILE: "process",
    MCP_VISUAL_PROOF_UI: "0",
    MCP_VISUAL_PROOF_REVIEW: "0",
    MCP_PUBLIC_ORIGIN: publicOrigin,
    MCP_OWNER_AUTH_ORIGIN: ownerAuthOrigin,
    TAILSCALE_OWNER_LOGIN: ownerLogin,
    MCP_OAUTH_STORE_PATH: join(temporary, "oauth.json"),
    MCP_TRANSPORT_LOG_PATH: join(temporary, "transport.jsonl"),
    MCP_PROCESS_RECEIPT_DIR: join(temporary, "receipts"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let stderr = "";
server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
try {
  try { await waitHealth(origin, port); } catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}; server_exit=${server.exitCode}; server_stderr=${stderr.trim()}`); }

  const rfc8414Metadata = await jsonFetch(`${origin}/.well-known/oauth-authorization-server`);
  assert.equal(rfc8414Metadata.response.status, 200, rfc8414Metadata.text);
  assert.equal(rfc8414Metadata.body.authorization_endpoint, `${ownerAuthOrigin}/authorize`);
  assert.equal(rfc8414Metadata.body.token_endpoint, `${publicOrigin}/token`);
  assert.equal(rfc8414Metadata.body.registration_endpoint, `${publicOrigin}/register`);

  const metadata = await jsonFetch(`${origin}/.well-known/openid-configuration`);
  assert.equal(metadata.response.status, 200, metadata.text);
  assert.equal(metadata.body.authorization_endpoint, `${ownerAuthOrigin}/authorize`);
  assert.equal(metadata.body.token_endpoint, `${publicOrigin}/token`);
  assert.equal(metadata.body.registration_endpoint, `${publicOrigin}/register`);

  const registration = await jsonFetch(`${origin}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "owner-auth-origin-test",
    }),
  });
  assert.equal(registration.response.status, 201, registration.text);
  const client = registration.body;
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abcd";
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const authorization = new URL("/authorize", origin);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    scope: "mcp offline_access",
    state: "owner-auth-origin-test",
  })) authorization.searchParams.set(key, value);
  const path = `${authorization.pathname}${authorization.search}`;
  const publicHost = new URL(publicOrigin).host;
  const ownerHost = new URL(ownerAuthOrigin).host;

  const publicSpoof = await localRequest(origin, path, { host: publicHost, headers: { "tailscale-user-login": ownerLogin } });
  assert.equal(publicSpoof.status, 403, publicSpoof.text);
  assert.match(publicSpoof.text, /Owner authorization required/);

  const funnelSpoof = await localRequest(origin, path, { host: ownerHost, headers: { "tailscale-user-login": ownerLogin, "tailscale-funnel-request": "1" } });
  assert.equal(funnelSpoof.status, 403, funnelSpoof.text);

  const missingIdentity = await localRequest(origin, path, { host: ownerHost });
  assert.equal(missingIdentity.status, 403, missingIdentity.text);

  const wrongIdentity = await localRequest(origin, path, { host: ownerHost, headers: { "tailscale-user-login": "attacker@example.com" } });
  assert.equal(wrongIdentity.status, 403, wrongIdentity.text);

  const trustedOwner = await localRequest(origin, path, { host: ownerHost, headers: { "tailscale-user-login": ownerLogin } });
  assert.equal(trustedOwner.status, 302, trustedOwner.text);
  const location = trustedOwner.headers.location;
  assert.ok(location);
  const redirect = new URL(location);
  assert.equal(redirect.origin + redirect.pathname, redirectUri);
  assert.equal(redirect.searchParams.get("state"), "owner-auth-origin-test");
  const code = redirect.searchParams.get("code");
  assert.ok(code);

  const token = await jsonFetch(`${origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: redirectUri, code_verifier: verifier, resource }),
  });
  assert.equal(token.response.status, 200, token.text);
  assert.ok(token.body.access_token);
  assert.ok(token.body.refresh_token);

  const refreshed = await jsonFetch(`${origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: token.body.refresh_token, resource, scope: "mcp offline_access" }),
  });
  assert.equal(refreshed.response.status, 200, refreshed.text);
  assert.ok(refreshed.body.access_token);

  console.log("PASS owner_auth_origin metadata_private=true public_spoof_blocked=true funnel_blocked=true missing_identity_blocked=true wrong_identity_blocked=true pkce=true refresh_continuity=true");
} finally {
  if (server.exitCode === null) server.kill();
  await new Promise((resolveExit) => server.exitCode !== null ? resolveExit() : server.once("exit", resolveExit));
  rmSync(temporary, { recursive: true, force: true });
}
