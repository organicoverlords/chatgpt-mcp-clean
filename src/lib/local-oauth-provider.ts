import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const ACCESS_TTL_SEC = 60 * 60;
const REFRESH_TTL_SEC = 7 * 24 * 60 * 60;
const CODE_TTL_MS = 60_000;
const REFRESH_REUSE_GRACE_MS = 120_000;
const MAX_CLIENTS = 64;
const SUPPORTED_SCOPES = new Set(["mcp", "offline_access"]);

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
}
interface StoreShape {
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, TokenRecord>;
  refresh: Record<string, TokenRecord>;
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
export class LocalOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private access = new Map<string, TokenRecord>();
  private refresh = new Map<string, TokenRecord>();
  private codes = new Map<string, CodeRecord>();

  constructor(
    private readonly resourceUrl: URL,
    private readonly ownerLogin: string,
    private readonly storePath: string,
  ) { this.load(); }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.clients.get(clientId),
      registerClient: async (raw) => {
        const client = raw as OAuthClientInformationFull;
        if (client.token_endpoint_auth_method !== "none") throw new InvalidClientMetadataError("Only public PKCE clients are accepted");
        if (!client.redirect_uris?.length || !client.redirect_uris.every(isChatGptRedirect)) throw new InvalidClientMetadataError("Only exact ChatGPT OAuth callbacks are accepted");
        if (client.grant_types?.some((g) => g !== "authorization_code" && g !== "refresh_token")) throw new InvalidClientMetadataError("Unsupported grant type");
        if (client.response_types?.some((r) => r !== "code")) throw new InvalidClientMetadataError("Unsupported response type");
        const full = { ...client, client_id: client.client_id || randomUUID(), client_id_issued_at: client.client_id_issued_at || Math.floor(Date.now() / 1000) };
        this.prune();
        while (this.clients.size >= MAX_CLIENTS) this.clients.delete(this.clients.keys().next().value as string);
        this.clients.set(full.client_id, full);
        this.persist();
        return full;
      },
    };
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.prune();
    const resource = this.validateResource(params.resource);
    const scopes = this.validateScopes(params.scopes);
    const code = freshToken();
    this.codes.set(code, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes,
      resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code);
    if (params.state) redirect.searchParams.set("state", params.state);
    res.redirect(302, redirect.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const rec = this.getCode(client, code);
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const rec = this.getCode(client, code);
    if (redirectUri && redirectUri !== rec.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    if (resource && canonical(resource) !== rec.resource) throw new InvalidTargetError("resource mismatch");
    this.codes.delete(code);
    return this.issuePair(client.client_id, rec.scopes, rec.resource);
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.prune();
    const key = digest(refreshToken);
    const rec = this.refresh.get(key);
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= Date.now()) throw new InvalidGrantError("Invalid refresh token");
    if (resource && canonical(resource) !== rec.resource) throw new InvalidTargetError("resource mismatch");
    const nextScopes = scopes?.length ? this.validateScopes(scopes) : rec.scopes;
    if (nextScopes.some((s) => !rec.scopes.includes(s))) throw new InvalidScopeError("scope escalation denied");

    // Keep refresh tokens stable. Some connector runtimes can retry an earlier refresh
    // after a successful exchange; rotating here made those retries fail after the grace window.
    rec.scopes = nextScopes;
    rec.expiresAt = Date.now() + REFRESH_TTL_SEC * 1000;
    delete rec.supersededAt;
    const accessToken = freshToken();
    this.access.set(digest(accessToken), {
      clientId: client.client_id, scopes: nextScopes, resource: rec.resource, subject: rec.subject,
      expiresAt: Date.now() + ACCESS_TTL_SEC * 1000,
    });
    this.persist();
    return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SEC, refresh_token: refreshToken, scope: nextScopes.join(" ") };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.prune();
    const rec = this.access.get(digest(token));
    if (!rec || rec.expiresAt <= Date.now()) throw new InvalidTokenError("Invalid or expired access token");
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
    const key = digest(request.token);
    this.access.delete(key);
    this.refresh.delete(key);
    this.persist();
  }
  private getCode(client: OAuthClientInformationFull, code: string): CodeRecord {
    this.prune();
    const rec = this.codes.get(code);
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

  private issuePair(clientId: string, scopes: string[], resource: string): OAuthTokens {
    const accessToken = freshToken();
    const refreshToken = freshToken();
    const now = Date.now();
    const common = { clientId, scopes, resource, subject: this.ownerLogin };
    this.access.set(digest(accessToken), { ...common, expiresAt: now + ACCESS_TTL_SEC * 1000 });
    this.refresh.set(digest(refreshToken), { ...common, expiresAt: now + REFRESH_TTL_SEC * 1000 });
    this.persist();
    return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SEC, refresh_token: refreshToken, scope: scopes.join(" ") };
  }
  private prune(): void {
    const now = Date.now();
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
      for (const [id, client] of Object.entries(data.clients ?? {})) this.clients.set(id, client);
      for (const [key, rec] of Object.entries(data.access ?? {})) this.access.set(key, rec);
      for (const [key, rec] of Object.entries(data.refresh ?? {})) this.refresh.set(key, rec);
      this.prune();
    } catch {
      this.clients.clear();
      this.access.clear();
      this.refresh.clear();
    }
  }

  private persist(): void {
    this.prune();
    const data: StoreShape = {
      clients: Object.fromEntries(this.clients),
      access: Object.fromEntries(this.access),
      refresh: Object.fromEntries(this.refresh),
    };
    mkdirSync(dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.storePath);
  }
}
