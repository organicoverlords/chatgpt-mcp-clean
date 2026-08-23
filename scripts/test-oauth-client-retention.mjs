import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalOAuthProvider } from "../dist/lib/local-oauth-provider.js";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "shell-mcp-oauth-retention-"));
const storePath = path.join(tempDir, "oauth.json");
const resourceUrl = new URL("https://shell-mcp-retention-test.ts.net/mcp");
const redirectUri = "https://chatgpt.com/connector/oauth/retained-client";

function metadata(name, redirect = redirectUri) {
  return {
    redirect_uris: [redirect],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: name,
  };
}

async function issueTokens(provider, client) {
  let location = "";
  await provider.authorize(client, {
    redirectUri,
    codeChallenge: "retention-test-challenge",
    scopes: ["mcp", "offline_access"],
    resource: resourceUrl,
    state: "retention-test",
  }, {
    redirect(status, nextLocation) {
      assert.equal(status, 302);
      location = nextLocation;
    },
  });
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);
  return provider.exchangeAuthorizationCode(client, code, undefined, redirectUri, resourceUrl);
}

try {
  const provider = new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath);
  const retained = await provider.clientsStore.registerClient(metadata("retained-client"));
  const opencode = await provider.clientsStore.registerClient(metadata("opencode", "http://127.0.0.1:19876/callback"));
  const traycer = await provider.clientsStore.registerClient(metadata("traycer", "https://platform.traycer.ai/oauth/callback"));
  const traycerConfidential = await provider.clientsStore.registerClient({
    ...metadata("traycer-confidential", "https://platform.traycer.ai/oauth/callback"),
    token_endpoint_auth_method: "client_secret_post",
  });
  assert.equal(opencode.redirect_uris[0], "http://127.0.0.1:19876/callback");
  assert.equal(traycer.redirect_uris[0], "https://platform.traycer.ai/oauth/callback");
  assert.equal(traycerConfidential.token_endpoint_auth_method, "client_secret_post");
  assert.ok(traycerConfidential.client_secret);
  await assert.rejects(
    provider.clientsStore.registerClient(metadata("untrusted", "https://evil.example/oauth/callback")),
    /Only ChatGPT, loopback PKCE, or Traycer HTTPS OAuth callbacks are accepted/,
  );
  const tokens = await issueTokens(provider, retained);
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);

  for (let index = 0; index < 96; index += 1) {
    const redirect = `https://chatgpt.com/connector/oauth/churn-${index}`;
    await provider.clientsStore.registerClient(metadata(`churn-${index}`, redirect));
  }

  assert.equal((await provider.clientsStore.getClient(retained.client_id))?.client_id, retained.client_id);
  const compacted = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(Object.keys(compacted.clients).length, 64);

  const reloaded = new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath);
  const persistedClient = await reloaded.clientsStore.getClient(retained.client_id);
  assert.equal(persistedClient?.client_id, retained.client_id);
  const refreshed = await reloaded.exchangeRefreshToken(persistedClient, tokens.refresh_token, ["mcp", "offline_access"], resourceUrl);
  assert.ok(refreshed.access_token);
  assert.equal(refreshed.refresh_token, tokens.refresh_token);

  const legacyStore = JSON.parse(await readFile(storePath, "utf8"));
  delete legacyStore.clients[retained.client_id];
  await writeFile(storePath, `${JSON.stringify(legacyStore, null, 2)}\n`, "utf8");

  const recovered = new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath);
  const recoveredClient = await recovered.clientsStore.getClient(retained.client_id);
  assert.equal(recoveredClient?.client_id, retained.client_id);
  assert.deepEqual(recoveredClient?.redirect_uris, []);
  const recoveredRefresh = await recovered.exchangeRefreshToken(recoveredClient, tokens.refresh_token, ["mcp", "offline_access"], resourceUrl);
  assert.ok(recoveredRefresh.access_token);
  assert.equal(await recovered.clientsStore.getClient("missing-client"), undefined);

  console.log("PASS oauth_client_retention churn=96 persisted=true orphan_refresh_recovered=true secrets=not_printed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
