import { createHash, randomBytes } from "node:crypto";

/**
 * GitHub calls for the optional personal-account billing credential (design
 * §3.4): validating a stored token (`GET /user`), the "Connect GitHub" web
 * flow of the App (PKCE S256), refreshing user-to-server tokens (the refresh
 * token rotates on every use) and revoking them.
 *
 * No database access and no logging here: storage, encryption and the
 * refresh-in-one-transaction rule live in src/server/ingest/billing-credential.ts.
 * `fetch` is a parameter so the token endpoint can be mocked in tests.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const GITHUB_API = "https://api.github.com";
export const GITHUB_WEB = "https://github.com";
const TIMEOUT_MS = 20_000;

/** Tokens from the web flow or a refresh. Expiry times are absolute. */
export type UserTokenSet = {
  accessToken: string;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
};

export type GitHubUser = { id: bigint; login: string };

/**
 * The token's owner, plus the expiry GitHub reports for expiring PATs and the
 * OAuth scopes of a classic token (`x-oauth-scopes`; fine-grained PATs and
 * user-to-server tokens send none).
 */
export type TokenOwner = GitHubUser & {
  tokenExpiresAt: Date | null;
  oauthScopes: string[];
};

/** Fine-grained personal access tokens start with this prefix. */
export const FINE_GRAINED_PAT_PREFIX = "github_pat_";

/** True for a fine-grained PAT shape (classic `ghp_`, OAuth `gho_` and other tokens are not). */
export function isFineGrainedPat(token: string): boolean {
  return /^github_pat_[A-Za-z0-9_]{20,250}$/.test(token);
}

/** Parses `x-oauth-scopes` ("repo, admin:org") into a list; empty when absent. */
export function parseOAuthScopes(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parses `github-authentication-token-expiration` ("2026-12-01 10:00:00 UTC"). */
export function parseTokenExpiry(value: string | null): Date | null {
  if (!value) return null;
  const m = value
    .trim()
    .match(
      /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/,
    );
  if (!m) return null;
  const zone =
    !m[3] || m[3] === "UTC" || m[3] === "Z"
      ? "Z"
      : m[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = Date.parse(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(t) ? null : new Date(t);
}

/** An OAuth error from GitHub's token endpoint, e.g. `bad_refresh_token`. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`GitHub OAuth error: ${code}`);
    this.name = "OAuthError";
  }

  /** The grant is gone: the account owner has to connect again. */
  get reconnectRequired(): boolean {
    return [
      "bad_refresh_token",
      "bad_verification_code",
      "invalid_grant",
      "unauthorized",
    ].includes(this.code);
  }
}

/** A REST call answered with an error status (the message never contains the token). */
export class GitHubHttpError extends Error {
  constructor(readonly status: number) {
    super(`GitHub answered ${status}`);
    this.name = "GitHubHttpError";
  }
}

function signal() {
  return AbortSignal.timeout(TIMEOUT_MS);
}

/** `GET /user` with the token: who it belongs to. 401 for a bad or expired token. */
export async function fetchTokenOwner(
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<TokenOwner> {
  const res = await fetchImpl(`${GITHUB_API}/user`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "devops-manager",
    },
    signal: signal(),
  });
  if (!res.ok) throw new GitHubHttpError(res.status);
  const body = (await res.json()) as { id?: unknown; login?: unknown };
  if (typeof body.id !== "number" || typeof body.login !== "string")
    throw new GitHubHttpError(502);
  return {
    id: BigInt(body.id),
    login: body.login,
    tokenExpiresAt: parseTokenExpiry(
      res.headers.get("github-authentication-token-expiration"),
    ),
    oauthScopes: parseOAuthScopes(res.headers.get("x-oauth-scopes")),
  };
}

/** True when `login` is the installation's account (GitHub logins are case-insensitive). */
export function sameLogin(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// ---------- PKCE and the authorize URL ----------

export type Pkce = { verifier: string; challenge: string };

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(24).toString("base64url");
}

/** The App's web-flow authorize URL; `login` preselects the expected account. */
export function authorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  login?: string;
}): string {
  const url = new URL(`${GITHUB_WEB}/login/oauth/authorize`);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "false");
  if (opts.login) url.searchParams.set("login", opts.login);
  return url.toString();
}

// ---------- token endpoint ----------

type TokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
  error?: unknown;
};

/** Parses the token endpoint answer. GitHub reports errors with status 200 and an `error` field. */
export function parseTokenResponse(
  status: number,
  body: TokenResponse,
  now: Date,
): UserTokenSet {
  if (typeof body.error === "string") throw new OAuthError(body.error, status);
  if (status >= 400) throw new OAuthError("http_error", status);
  if (typeof body.access_token !== "string" || body.access_token.length === 0)
    throw new OAuthError("no_access_token", status);
  const at = (seconds: unknown) =>
    typeof seconds === "number" && seconds > 0
      ? new Date(now.getTime() + seconds * 1000)
      : null;
  return {
    accessToken: body.access_token,
    accessTokenExpiresAt: at(body.expires_in),
    refreshToken:
      typeof body.refresh_token === "string" && body.refresh_token.length > 0
        ? body.refresh_token
        : null,
    refreshTokenExpiresAt: at(body.refresh_token_expires_in),
  };
}

async function tokenRequest(
  params: Record<string, string>,
  fetchImpl: Fetch,
  now: Date,
): Promise<UserTokenSet> {
  const res = await fetchImpl(`${GITHUB_WEB}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "devops-manager",
    },
    body: new URLSearchParams(params).toString(),
    signal: signal(),
  });
  let body: TokenResponse = {};
  try {
    body = (await res.json()) as TokenResponse;
  } catch {
    body = {};
  }
  return parseTokenResponse(res.status, body, now);
}

export type AppClient = { clientId: string; clientSecret: string };

/** Exchanges the web-flow code (with the PKCE verifier) for a user-to-server token. */
export function exchangeCode(
  app: AppClient,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  fetchImpl: Fetch = fetch,
  now: Date = new Date(),
): Promise<UserTokenSet> {
  return tokenRequest(
    {
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    },
    fetchImpl,
    now,
  );
}

/**
 * Refreshes a user-to-server token. GitHub invalidates the used refresh token
 * and the old access token, so the caller must persist the returned set
 * before anything else can use the credential.
 */
export function refreshUserToken(
  app: AppClient,
  refreshToken: string,
  fetchImpl: Fetch = fetch,
  now: Date = new Date(),
): Promise<UserTokenSet> {
  return tokenRequest(
    {
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    fetchImpl,
    now,
  );
}

/** Outcome of a revocation call: "gone" when GitHub no longer knows the token (404). */
export type RevokeOutcome = "revoked" | "gone";

async function deleteWithToken(
  app: AppClient,
  path: "token" | "grant",
  accessToken: string,
  fetchImpl: Fetch,
): Promise<RevokeOutcome> {
  const basic = Buffer.from(`${app.clientId}:${app.clientSecret}`).toString(
    "base64",
  );
  const res = await fetchImpl(
    `${GITHUB_API}/applications/${encodeURIComponent(app.clientId)}/${path}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Basic ${basic}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "devops-manager",
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: signal(),
    },
  );
  if (res.status === 404) return "gone";
  if (!res.ok) throw new GitHubHttpError(res.status);
  return "revoked";
}

/**
 * `DELETE /applications/{client_id}/token` (Basic auth with the App's client
 * credentials): revokes this one access token. 404 means GitHub no longer
 * knows it (expired or already revoked); its refresh token may still live,
 * so a full revocation uses {@link revokeUserGrant}.
 */
export function revokeUserToken(
  app: AppClient,
  accessToken: string,
  fetchImpl: Fetch = fetch,
): Promise<RevokeOutcome> {
  return deleteWithToken(app, "token", accessToken, fetchImpl);
}

/**
 * `DELETE /applications/{client_id}/grant`: revokes the user's whole
 * authorisation of the App, every access and refresh token included. The
 * access token only identifies the grant, so it must still be valid.
 */
export function revokeUserGrant(
  app: AppClient,
  accessToken: string,
  fetchImpl: Fetch = fetch,
): Promise<RevokeOutcome> {
  return deleteWithToken(app, "grant", accessToken, fetchImpl);
}
