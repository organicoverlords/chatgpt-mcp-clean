import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function tokenDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function issueTokens(provider, client, scopes = ["mcp", "offline_access"]) {
  const clientRedirectUri = client.redirect_uris[0];
  assert.ok(clientRedirectUri);
  let location = "";
  await provider.authorize(client, {
    redirectUri: clientRedirectUri,
    codeChallenge: "retention-test-challenge",
    scopes,
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
  return provider.exchangeAuthorizationCode(client, code, undefined, clientRedirectUri, resourceUrl);
}

async function mutateRefreshRecord(token, mutate) {
  const state = JSON.parse(await readFile(storePath, "utf8"));
  const record = state.refresh[tokenDigest(token)];
  assert.ok(record, "refresh record must exist before mutation");
  mutate(record);
  await writeFile(storePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

try {
  const provider = new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath);
  const retained = await provider.clientsStore.registerClient(metadata("retained-client"));
  const dormant = await provider.clientsStore.registerClient(metadata("dormant-chatgpt-client"));
  const opencode = await provider.clientsStore.registerClient(metadata("opencode", "http://127.0.0.1:19876/callback"));
  const traycer = await provider.clientsStore.registerClient(metadata("traycer", "https://platform.traycer.ai/oauth/callback"));
  const traycerConfidential = await provider.clientsStore.registerClient({
    ...metadata("traycer-confidential", "https://platform.traycer.ai/oauth/callback"),
    token_endpoint_auth_method: "client_secret_post",
  });
  const traycerBasic = await provider.clientsStore.registerClient({
    ...metadata("traycer-basic", "https://auth.traycer.ai/auth/v1/callback"),
    token_endpoint_auth_method: "client_secret_basic",
  });
  assert.equal(opencode.redirect_uris[0], "http://127.0.0.1:19876/callback");
  assert.equal(traycer.redirect_uris[0], "https://platform.traycer.ai/oauth/callback");
  assert.equal(traycerConfidential.token_endpoint_auth_method, "client_secret_post");
  assert.ok(traycerConfidential.client_secret);
  assert.equal(traycerBasic.token_endpoint_auth_method, "client_secret_post");
  assert.ok(traycerBasic.client_secret);
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
  assert.equal((await provider.clientsStore.getClient(dormant.client_id))?.client_id, dormant.client_id);
  const compacted = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(compacted.clients[dormant.client_id].client_id, dormant.client_id);

  const reloaded = new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath);
  const persistedClient = await reloaded.clientsStore.getClient(retained.client_id);
  assert.equal(persistedClient?.client_id, retained.client_id);
  assert.equal((await reloaded.clientsStore.getClient(dormant.client_id))?.client_id, dormant.client_id);
  const refreshed = await reloaded.exchangeRefreshToken(persistedClient, tokens.refresh_token, ["mcp", "offline_access"], resourceUrl);
  assert.ok(refreshed.access_token);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);

  const retried = await reloaded.exchangeRefreshToken(persistedClient, tokens.refresh_token, ["mcp", "offline_access"], resourceUrl);
  assert.ok(retried.access_token);
  assert.notEqual(retried.refresh_token, tokens.refresh_token);
  assert.notEqual(retried.refresh_token, refreshed.refresh_token);
  await assert.rejects(
    reloaded.exchangeRefreshToken(persistedClient, tokens.refresh_token, ["mcp", "offline_access"], resourceUrl),
    /Refresh token replay detected/,
  );
  const afterReplay = new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath);
  await assert.rejects(
    afterReplay.exchangeRefreshToken(persistedClient, retried.refresh_token, ["mcp", "offline_access"], resourceUrl),
    /Invalid refresh token/,
  );

  const agedTokens = await issueTokens(afterReplay, persistedClient);
  const agedSuccessor = await afterReplay.exchangeRefreshToken(persistedClient, agedTokens.refresh_token, undefined, resourceUrl);
  await mutateRefreshRecord(agedTokens.refresh_token, (record) => { record.supersededAt = Date.now() - 120_001; });
  const agedReplay = new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath);
  await assert.rejects(
    agedReplay.exchangeRefreshToken(persistedClient, agedTokens.refresh_token, undefined, resourceUrl),
    /Refresh token replay detected/,
  );
  await assert.rejects(
    new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath).exchangeRefreshToken(persistedClient, agedSuccessor.refresh_token, undefined, resourceUrl),
    /Invalid refresh token/,
  );

  const expiringTokens = await issueTokens(new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath), persistedClient);
  await mutateRefreshRecord(expiringTokens.refresh_token, (record) => { record.expiresAt = Date.now() - 1; });
  await assert.rejects(
    new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath).exchangeRefreshToken(persistedClient, expiringTokens.refresh_token, undefined, resourceUrl),
    /Invalid refresh token/,
  );

  const narrowTokens = await issueTokens(new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath), persistedClient, ["mcp"]);
  await assert.rejects(
    new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath).exchangeRefreshToken(persistedClient, narrowTokens.refresh_token, ["mcp", "offline_access"], resourceUrl),
    /scope escalation denied/,
  );
  await assert.rejects(
    new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath).exchangeRefreshToken(dormant, narrowTokens.refresh_token, ["mcp"], resourceUrl),
    /Invalid refresh token/,
  );
  await assert.rejects(
    new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath).exchangeRefreshToken(persistedClient, narrowTokens.refresh_token, ["mcp"], new URL("https://other.example/mcp")),
    /resource mismatch/,
  );

  const confidentialTokens = await issueTokens(new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath), traycerConfidential);
  const confidentialRefreshed = await new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath).exchangeRefreshToken(
    traycerConfidential, confidentialTokens.refresh_token, ["mcp", "offline_access"], resourceUrl,
  );
  assert.equal(confidentialRefreshed.refresh_token, confidentialTokens.refresh_token);

  const legacyTokens = await issueTokens(new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath), persistedClient);
  const legacyRotated = await new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath).exchangeRefreshToken(
    persistedClient, legacyTokens.refresh_token, ["mcp", "offline_access"], resourceUrl,
  );
  const legacyStore = JSON.parse(await readFile(storePath, "utf8"));
  delete legacyStore.clients[retained.client_id];
  await writeFile(storePath, `${JSON.stringify(legacyStore, null, 2)}\n`, "utf8");

  const recovered = new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath);
  const recoveredClient = await recovered.clientsStore.getClient(retained.client_id);
  assert.equal(recoveredClient?.client_id, retained.client_id);
  assert.deepEqual(recoveredClient?.redirect_uris, []);
  const recoveredRefresh = await recovered.exchangeRefreshToken(recoveredClient, legacyRotated.refresh_token, ["mcp", "offline_access"], resourceUrl);
  assert.ok(recoveredRefresh.access_token);
  assert.notEqual(recoveredRefresh.refresh_token, legacyRotated.refresh_token);
  assert.equal(await recovered.clientsStore.getClient("missing-client"), undefined);

  const staleClientId = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(recovered.recoverLegacyChatGptClient(staleClientId, "https://evil.example/oauth/callback"), false);
  assert.equal(recovered.recoverLegacyChatGptClient("not-a-uuid", redirectUri), false);
  assert.equal(recovered.recoverLegacyChatGptClient(staleClientId, redirectUri), true);
  assert.deepEqual((await recovered.clientsStore.getClient(staleClientId))?.redirect_uris, [redirectUri]);
  const recoveredAgain = new LocalOAuthProvider(resourceUrl, "owner@example.com", storePath);
  assert.deepEqual((await recoveredAgain.clientsStore.getClient(staleClientId))?.redirect_uris, [redirectUri]);

  console.log("PASS oauth_client_retention churn=96 public_refresh_rotation=true retry_grace_bounded=true replay_revokes_family=true expiry_enforced=true scope_resource_client_bound=true confidential_refresh_compatible=true orphan_refresh_recovered=true stale_chatgpt_authorize_recovered=true secrets=not_printed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
