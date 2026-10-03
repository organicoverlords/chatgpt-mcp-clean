import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir as mkdirAsync, open as openAsync, readFile as readFileAsync, rename as renameAsync, stat as statAsync, unlink as unlinkAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { dirname } from "node:path";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { emitTelemetry } from "./transport-telemetry.js";

const ACCESS_TTL_SEC = 60 * 60;
const REFRESH_TTL_SEC = 7 * 24 * 60 * 60;
const CODE_TTL_MS = 60_000;
const REFRESH_REUSE_GRACE_MS = 120_000;
const MAX_CLIENTS = 64;
const STORE_LOCK_TIMEOUT_MS = 2_000;
const STORE_LOCK_STALE_MS = 15_000;
const STORE_LOCK_RETRY_MS = 10;
const SUPPORTED_SCOPES = new Set(["mcp", "offline_access"]);
const UUID_CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISPOSABLE_CLIENT_NAMES = new Set([
  "busy-probe",
  "restart-proof",
  "shell-mcp-probe",
  "shell-mcp-smoke",
  "shell-mcp-stress",
]);

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}
interface TokenRecord {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
  subject: string;
  supersededAt?: number;
  supersededReuseCount?: number;
  successorRefreshDigest?: string;
}
interface StoreShape {
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, TokenRecord>;
  refresh: Record<string, TokenRecord>;
  codes?: Record<string, CodeRecord>;
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function freshToken(): string { return randomBytes(32).toString("base64url"); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonical(url: URL | string): string { return new URL(url.toString()).href; }
function isChatGptRedirect(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "chatgpt.com" &&
      /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname) && !u.search && !u.hash && !u.username && !u.password;
  } catch { return false; }
}
function isLoopbackRedirect(value: string): boolean {
  try {
    const u = new URL(value);
    const hostname = u.hostname.toLowerCase();
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname) &&
      Boolean(u.port) && !u.search && !u.hash && !u.username && !u.password;
  } catch { return false; }
}
function isTraycerRedirect(value: string): boolean {
  try {
    const u = new URL(value);
    const hostname = u.hostname.toLowerCase();
    return u.protocol === "https:" && (hostname === "traycer.ai" || hostname.endsWith(".traycer.ai")) &&
      !u.search && !u.hash && !u.username && !u.password;
  } catch { return false; }
}
function isAllowedRedirect(value: string): boolean {
  return isChatGptRedirect(value) || isLoopbackRedirect(value) || isTraycerRedirect(value);
}
export class LocalOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private access = new Map<string, TokenRecord>();
  private refresh = new Map<string, TokenRecord>();
  private codes = new Map<string, CodeRecord>();
  // Keep the successor only in memory for the short retry window. The durable
  // store continues to hold refresh-token digests, never plaintext tokens.
  private recentRefreshSuccessors = new Map<string, { token: string; digest: string; issuedAt: number }>();

  constructor(
    private readonly resourceUrl: URL,
    private readonly ownerLogin: string,
    private readonly storePath: string,
  ) {
    this.load();
  }

  private async loadAsync(): Promise<void> {
    try {
      const data = JSON.parse(await readFileAsync(this.storePath, "utf8")) as StoreShape;
      const clients = new Map(Object.entries(data.clients ?? {}));
      const access = new Map(Object.entries(data.access ?? {}));
      const refresh = new Map(Object.entries(data.refresh ?? {}));
      const codes = new Map(Object.entries(data.codes ?? {}));
      this.clients.clear();
      this.access.clear();
      this.refresh.clear();
      this.codes.clear();
      for (const [id, client] of clients) this.clients.set(id, client);
      for (const [key, rec] of access) this.access.set(key, rec);
      for (const [key, rec] of refresh) this.refresh.set(key, rec);
      for (const [key, rec] of codes) this.codes.set(key, rec);
      this.prune();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        emitTelemetry({ event: "oauth_store_read_error", error_message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async persistAsync(): Promise<void> {
    this.prune();
    const data: StoreShape = {
      clients: Object.fromEntries(this.clients),
      access: Object.fromEntries(this.access),
      refresh: Object.fromEntries(this.refresh),
      codes: Object.fromEntries(this.codes),
    };
    await mkdirAsync(dirname(this.storePath), { recursive: true });
    const tmp = this.storePath + "." + randomUUID() + ".tmp";
    try {
      await writeFileAsync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await renameAsync(tmp, this.storePath);
    } finally {
      try { await unlinkAsync(tmp); } catch {}
    }
  }

  private async withStoreMutation<T>(fn: () => T | Promise<T>): Promise<T> {
    const lockPath = this.storePath + ".lock";
    await mkdirAsync(dirname(this.storePath), { recursive: true });
    const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;
    let handle: Awaited<ReturnType<typeof openAsync>> | undefined;
    for (;;) {
      try {
        handle = await openAsync(lockPath, "wx", 0o600);
        await handle.writeFile(String(process.pid), "utf8");
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EACCES" && code !== "EPERM") throw error;
        let holderAlive = false;
        try {
          const age = Date.now() - (await statAsync(lockPath)).mtimeMs;
          if (age > STORE_LOCK_STALE_MS) {
            const raw = (await readFileAsync(lockPath, "utf8")).trim();
            const pid = Number(raw);
            holderAlive = Number.isInteger(pid) && pid > 0 && pidIsAlive(pid);
            if (!holderAlive) {
              await unlinkAsync(lockPath);
              continue;
            }
          }
        } catch (staleError) {
          if ((staleError as NodeJS.ErrnoException).code === "ENOENT") continue;
        }
        if (Date.now() >= deadline) throw new Error("oauth_store_locked");
        await sleep(STORE_LOCK_RETRY_MS);
      }
    }
    try {
      await this.loadAsync();
      try {
        return await fn();
      } finally {
        await this.persistAsync();
      }
    } finally {
      try { await handle?.close(); } catch {}
      try { await unlinkAsync(lockPath); } catch {}
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: async (raw) => await this.withStoreMutation(() => {
        const client = raw as OAuthClientInformationFull;
        const requestedAuthMethod = client.token_endpoint_auth_method || "none";
        if (requestedAuthMethod !== "none" && requestedAuthMethod !== "client_secret_post" && requestedAuthMethod !== "client_secret_basic") throw new InvalidClientMetadataError("Unsupported token endpoint authentication method");
        // Some hosted MCP clients still send RFC 7591's confidential-client
        // default (`client_secret_basic`) even when metadata advertises
        // `client_secret_post`. The SDK token handler accepts credentials in
        // the POST body, so explicitly substitute the supported method in the
        // registration response instead of rejecting the client at DCR.
        const tokenEndpointAuthMethod = requestedAuthMethod === "client_secret_basic" ? "client_secret_post" : requestedAuthMethod;
        if (!client.redirect_uris?.length || !client.redirect_uris.every(isAllowedRedirect)) throw new InvalidClientMetadataError("Only ChatGPT, loopback PKCE, or Traycer HTTPS OAuth callbacks are accepted");
        if (client.grant_types?.some((g) => g !== "authorization_code" && g !== "refresh_token")) throw new InvalidClientMetadataError("Unsupported grant type");
        if (client.response_types?.some((r) => r !== "code")) throw new InvalidClientMetadataError("Unsupported response type");
        const full = {
          ...client,
          token_endpoint_auth_method: tokenEndpointAuthMethod,
          client_id: client.client_id || randomUUID(),
          client_id_issued_at: client.client_id_issued_at || Math.floor(Date.now() / 1000),
          ...(tokenEndpointAuthMethod === "client_secret_post" ? { client_secret: freshToken() } : {}),
        };
        this.prune();
        this.makeClientRoom();
        this.clients.set(full.client_id, full);
        return full;
      }),

    };
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    let code = "";
    await this.withStoreMutation(() => {

      const resource = this.validateResource(params.resource);
      const scopes = this.validateScopes(params.scopes);
        code = freshToken();
      this.codes.set(digest(code), {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scopes,
        resource,
        expiresAt: Date.now() + CODE_TTL_MS,
      });
    });
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code);
    if (params.state) redirect.searchParams.set("state", params.state);
    res.redirect(302, redirect.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    await this.loadAsync();
    const rec = this.getCode(client, code);
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    return await this.withStoreMutation(() => {
      const rec = this.getCode(client, code);
      if (redirectUri && redirectUri !== rec.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
      if (resource && canonical(resource) !== rec.resource) throw new InvalidTargetError("resource mismatch");
      this.codes.delete(digest(code));
      return this.issuePair(client.client_id, rec.scopes, rec.resource);
    });
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    return await this.withStoreMutation(async () => {
        const now = Date.now();
        const key = digest(refreshToken);
        const rec = this.refresh.get(key);
        if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= now) {
          emitTelemetry({ event: "oauth_refresh_rejected", reason: !rec ? "unknown_token" : rec.clientId !== client.client_id ? "client_mismatch" : "expired_token" });
          throw new InvalidGrantError("Invalid refresh token");
        }
        if (resource && canonical(resource) !== rec.resource) throw new InvalidTargetError("resource mismatch");
        const nextScopes = scopes?.length ? this.validateScopes(scopes) : rec.scopes;
        if (nextScopes.some((s) => !rec.scopes.includes(s))) throw new InvalidScopeError("scope escalation denied");

        const publicClient = (client.token_endpoint_auth_method || "none") === "none";
        if (!publicClient) {
          rec.scopes = nextScopes;
          rec.expiresAt = now + REFRESH_TTL_SEC * 1000;
          delete rec.supersededAt;
          delete rec.supersededReuseCount;
          delete rec.successorRefreshDigest;
          const accessToken = freshToken();
          this.access.set(digest(accessToken), {
            clientId: client.client_id, scopes: nextScopes, resource: rec.resource, subject: rec.subject,
            expiresAt: now + ACCESS_TTL_SEC * 1000,
          });
          emitTelemetry({ event: "oauth_refresh_completed", mode: "confidential" });
          return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SEC, refresh_token: refreshToken, scope: nextScopes.join(" ") };
        }

        if (rec.supersededAt !== undefined) {
          const insideRetryGrace = now - rec.supersededAt <= REFRESH_REUSE_GRACE_MS;
          const successor = rec.successorRefreshDigest ? this.refresh.get(rec.successorRefreshDigest) : undefined;
          const familyAlreadyAdvanced = successor?.supersededAt !== undefined;
          if (!insideRetryGrace) {
            this.revokeRefreshFamily(key);
              emitTelemetry({ event: "oauth_refresh_rejected", reason: "replay_outside_grace", family_revoked: true });
            throw new InvalidGrantError("Refresh token replay detected");
          }
          if (familyAlreadyAdvanced) {
            emitTelemetry({ event: "oauth_refresh_rejected", reason: "successor_already_rotated", family_revoked: false });
            throw new InvalidGrantError("Refresh token already rotated");
          }
          const recent = this.recentRefreshSuccessors.get(key);
          if (recent && recent.digest === rec.successorRefreshDigest && successor) {
            if (nextScopes.join(" ") !== successor.scopes.join(" ")) throw new InvalidScopeError("refresh retry scope mismatch");
            const accessToken = freshToken();
            this.access.set(digest(accessToken), {
              clientId: client.client_id, scopes: nextScopes, resource: rec.resource, subject: rec.subject,
              expiresAt: now + ACCESS_TTL_SEC * 1000,
            });
              emitTelemetry({ event: "oauth_refresh_completed", mode: "coalesced_retry" });
            return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SEC, refresh_token: recent.token, scope: nextScopes.join(" ") };
          }
          // Never branch a refresh family after restart. A lost retry response must
          // not invalidate the successor already delivered to another request.
          emitTelemetry({ event: "oauth_refresh_rejected", reason: "retry_not_cached", family_revoked: false });
          throw new InvalidGrantError("Refresh retry unavailable after restart");
        } else {
          rec.supersededAt = now;
          // Retain the hash as a bounded replay-detection tombstone; it is no longer
          // usable after the short retry grace even though the record remains durable.
          rec.expiresAt = now + REFRESH_TTL_SEC * 1000;
        }

        rec.scopes = nextScopes;
        const accessToken = freshToken();
        const nextRefreshToken = freshToken();
        const nextRefreshDigest = digest(nextRefreshToken);
        const common = { clientId: client.client_id, scopes: nextScopes, resource: rec.resource, subject: rec.subject };
        this.access.set(digest(accessToken), { ...common, expiresAt: now + ACCESS_TTL_SEC * 1000 });
        this.refresh.set(nextRefreshDigest, { ...common, expiresAt: now + REFRESH_TTL_SEC * 1000 });
        rec.successorRefreshDigest = nextRefreshDigest;
        this.recentRefreshSuccessors.set(key, { token: nextRefreshToken, digest: nextRefreshDigest, issuedAt: now });
        emitTelemetry({ event: "oauth_refresh_completed", mode: "rotated" });
        return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SEC, refresh_token: nextRefreshToken, scope: nextScopes.join(" ") };

    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Known access tokens stay entirely in memory. A candidate backend that was
    // started before another backend issued the token gets one async store refresh
    // on the miss path so cross-generation handoff sees newly issued durable state.
    this.prune();
    const key = digest(token);
    let rec = this.access.get(key);
    if (!rec || rec.expiresAt <= Date.now()) {
      await this.loadAsync();
      this.prune();
      rec = this.access.get(key);
    }
    if (!rec || rec.expiresAt <= Date.now()) {
      emitTelemetry({ event: "oauth_access_rejected", reason: "unknown_or_expired_token" });
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      resource: new URL(rec.resource),
      extra: { subject: rec.subject },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.withStoreMutation(() => {
      const key = digest(request.token);
      this.access.delete(key);
      this.refresh.delete(key);
    });
  }
  private getCode(client: OAuthClientInformationFull, code: string): CodeRecord {
    this.prune();
    const rec = this.codes.get(digest(code));
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    return rec;
  }

  private validateResource(resource?: URL): string {
    const expected = canonical(this.resourceUrl);
    if (resource && canonical(resource) !== expected) throw new InvalidTargetError("Unknown resource");
    return expected;
  }

  private validateScopes(scopes?: string[]): string[] {
    const requested = scopes?.filter(Boolean) ?? [];
    const out = requested.length ? requested : ["mcp"];
    if (out.some((scope) => !SUPPORTED_SCOPES.has(scope))) throw new InvalidScopeError("Unsupported scope");
    return [...new Set(out)];
  }

  async recoverLegacyChatGptClient(clientId: string, redirectUri: string): Promise<boolean> {
    return await this.withStoreMutation(() => {
      this.prune();
      if (this.clients.has(clientId)) return false;
      if (!UUID_CLIENT_ID.test(clientId) || !isChatGptRedirect(redirectUri)) return false;
      this.clients.set(clientId, { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "recovered-chatgpt-client" });
      return true;
    });
  }

  async isChatGptAuthorizationReconnect(clientId: string, redirectUri: string): Promise<boolean> {
    await this.loadAsync();

    this.prune();
    if (!UUID_CLIENT_ID.test(clientId) || !isChatGptRedirect(redirectUri)) return false;
    const registered = this.clients.get(clientId);
    if (!registered) return this.isClientReferenced(clientId);
    const name = (registered.client_name || "").trim().toLowerCase();
    return (name === "chatgpt" || name === "recovered-chatgpt-client")
      && (registered.redirect_uris ?? []).includes(redirectUri);
    }

  private async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    await this.loadAsync();

    this.prune();
    const registered = this.clients.get(clientId);
    if (registered) return registered;

    // Older builds could evict a public client registration while retaining its
    // live token records. Refresh-token possession is still the credential for
    // these clients, so return the minimum metadata needed by the SDK's client
    // authentication middleware. Empty redirect URIs prevent this recovery
    // record from being reused for a new authorization-code flow.
    if (!this.isClientReferenced(clientId)) return undefined;
    return {
      client_id: clientId,
      redirect_uris: [],
      token_endpoint_auth_method: "none",
      grant_types: ["refresh_token"],
      response_types: [],
    };
    }

  private isClientReferenced(clientId: string): boolean {
    for (const rec of this.codes.values()) if (rec.clientId === clientId) return true;
    for (const rec of this.access.values()) if (rec.clientId === clientId) return true;
    for (const rec of this.refresh.values()) if (rec.clientId === clientId) return true;
    return false;
  }

  private makeClientRoom(): void {
    // A dynamically registered client_id is durable client state. ChatGPT can
    // reuse it after its last token has expired or been revoked, so lack of a
    // token reference is not permission to evict a real connector registration.
    // Compact only registrations created by this repository's disposable test
    // clients; otherwise exceed the soft target rather than break an account.
    while (this.clients.size >= MAX_CLIENTS) {
      const unusedClientId = [...this.clients.entries()].find(([clientId, client]) =>
        !this.isClientReferenced(clientId) && DISPOSABLE_CLIENT_NAMES.has(client.client_name ?? ""),
      )?.[0];
      if (!unusedClientId) return;
      this.clients.delete(unusedClientId);
    }
  }

  private revokeRefreshFamily(startKey: string): void {
    const seen = new Set<string>();
    let key: string | undefined = startKey;
    while (key && !seen.has(key)) {
      seen.add(key);
      const rec = this.refresh.get(key);
      const next = rec?.successorRefreshDigest;
      this.refresh.delete(key);
      this.recentRefreshSuccessors.delete(key);
      key = next;
    }
  }

  private issuePair(clientId: string, scopes: string[], resource: string): OAuthTokens {
    const accessToken = freshToken();
    const refreshToken = freshToken();
    const now = Date.now();
    const common = { clientId, scopes, resource, subject: this.ownerLogin };
    this.access.set(digest(accessToken), { ...common, expiresAt: now + ACCESS_TTL_SEC * 1000 });
    this.refresh.set(digest(refreshToken), { ...common, expiresAt: now + REFRESH_TTL_SEC * 1000 });
    return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SEC, refresh_token: refreshToken, scope: scopes.join(" ") };
  }
  private prune(): void {
    const now = Date.now();
    for (const [key, rec] of this.recentRefreshSuccessors) {
      if (now - rec.issuedAt > REFRESH_REUSE_GRACE_MS || !this.refresh.has(key)) this.recentRefreshSuccessors.delete(key);
    }
    for (const [code, rec] of this.codes) if (rec.expiresAt <= now) this.codes.delete(code);
    for (const [key, rec] of this.access) if (rec.expiresAt <= now) this.access.delete(key);
    for (const [key, rec] of this.refresh) {
      if (rec.expiresAt <= now) this.refresh.delete(key);
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.storePath)) return;
      const data = JSON.parse(readFileSync(this.storePath, "utf8")) as StoreShape;
      const clients = new Map(Object.entries(data.clients ?? {}));
      const access = new Map(Object.entries(data.access ?? {}));
      const refresh = new Map(Object.entries(data.refresh ?? {}));
      const codes = new Map(Object.entries(data.codes ?? {}));
      this.clients.clear();
      this.access.clear();
      this.refresh.clear();
      this.codes.clear();
      for (const [id, client] of clients) this.clients.set(id, client);
      for (const [key, rec] of access) this.access.set(key, rec);
      for (const [key, rec] of refresh) this.refresh.set(key, rec);
      for (const [key, rec] of codes) this.codes.set(key, rec);
      this.prune();
    } catch {
      // A transient read or parse failure must not erase the last good in-memory
      // snapshot. The next request retries the durable store.
    }
  }


}
