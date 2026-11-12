import "server-only";
import { randomUUID } from "node:crypto";
import { env } from "@/env";
import { actorProviderOf, appendAudit } from "@/server/audit/log";
import { hasRole } from "@/server/authz/roles";
import type { TenantScope } from "@/server/authz/scope";
import {
  connectEnabled,
  personalInstallation,
} from "@/server/data/personal-billing";
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  fetchTokenOwner,
  GitHubHttpError,
  isFineGrainedPat,
  OAuthError,
  randomState,
  revokeUserGrant,
  sameLogin,
  type AppClient,
  type Fetch,
} from "@/server/github/billing-credential";
import {
  consumeConnectState,
  deleteCredential,
  revokeStoredCredentialAtGitHub,
  saveConnectState,
  saveCredential,
  storedCredentialOwner,
  type CredentialDeps,
  type RemoteRevocation,
} from "@/server/ingest/billing-credential";

/**
 * The admin flows for the personal-account billing credential (design §3.4,
 * §8.2 #15): store a token (option A), "Connect GitHub" (option B) and
 * revoke. The Server Actions in src/server/actions/personal-billing.ts and
 * the callback route call these with the signed-in actor.
 *
 * Rules: admin only (others get a DENIED audit row); the installation must be
 * a visible personal installation (else NotFoundError, 404); the token's
 * GitHub login must equal the installation's account; store and revoke need
 * the account login typed as confirmation. Audit rows go to the
 * instance-level chain (installation 0) and never contain a token.
 *
 * Option A accepts fine-grained PATs only (`github_pat_`, no OAuth scopes),
 * so the stored secret cannot do more than billing needs. A connected
 * credential that is removed or replaced is revoked at GitHub first (the
 * whole grant, see revokeStoredCredentialAtGitHub), so no refresh token is
 * left behind that this instance can no longer see or revoke.
 */

export type Actor = {
  user: { id: string; name: string; email: string };
  scope: TenantScope;
};

export type CredentialActionStatus =
  | "saved"
  | "connected"
  | "revoked"
  | "revoked_locally"
  | "revoke_failed"
  | "redirect"
  | "forbidden"
  | "confirmation_mismatch"
  | "invalid_token"
  | "token_too_broad"
  | "login_mismatch"
  | "not_configured"
  | "invalid_state"
  | "github_error";

export type CredentialActionResult = {
  status: CredentialActionStatus;
  /** The GitHub login the token belongs to (saved, connected, login_mismatch). */
  login?: string;
  /** Authorize URL for "redirect". */
  url?: string;
};

export type FlowDeps = { fetch: Fetch; now: () => Date };

const defaultDeps = (): FlowDeps => ({
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
});

function appClient(): AppClient | null {
  return env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET
    ? {
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
      }
    : null;
}

function credentialDeps(deps: FlowDeps): CredentialDeps {
  return {
    app: appClient(),
    fetch: deps.fetch,
    now: deps.now,
    envToken: null,
  };
}

export function connectRedirectUri(): string {
  return new URL(
    "/api/github/connect/callback",
    env.BETTER_AUTH_URL,
  ).toString();
}

type AuditAction =
  | "BILLING_CREDENTIAL_SET"
  | "BILLING_CREDENTIAL_CONNECT"
  | "BILLING_CREDENTIAL_REVOKE";

async function audit(
  actor: Actor,
  action: AuditAction,
  installationId: bigint,
  status: "SUCCEEDED" | "FAILED" | "DENIED",
  params: Record<string, unknown>,
  confirmation: "TYPED" | "DIALOG" | "NONE",
  idempotencyKey?: string,
  error?: string,
) {
  await appendAudit({
    installationId: 0n,
    actorUserId: actor.user.id,
    actorDisplay: actor.user.name || actor.user.email,
    actorRole: actor.scope.role,
    actorProvider: await actorProviderOf(actor.user.id),
    actingAs: null,
    action,
    targetType: "credential",
    targetId: String(installationId),
    params: { installationId: String(installationId), ...params },
    confirmation,
    idempotencyKey: idempotencyKey ?? randomUUID(),
    status,
    error: error ?? null,
  });
}

/** Classic PATs, OAuth and other GitHub tokens: real tokens, but broader than billing needs. */
const OTHER_GITHUB_TOKEN = /^gh[a-z]_[A-Za-z0-9_]{20,255}$/;

/**
 * Option A: validate a fine-grained PAT with `GET /user` and store it
 * encrypted. Classic tokens (`ghp_`, or any token with `x-oauth-scopes`)
 * are refused with "token_too_broad".
 */
export async function storeBillingToken(
  actor: Actor,
  input: {
    installationId: bigint;
    token: string;
    confirmation: string;
    idempotencyKey?: string;
  },
  deps: FlowDeps = defaultDeps(),
): Promise<CredentialActionResult> {
  if (!hasRole(actor.scope.role, "ADMIN")) {
    await audit(
      actor,
      "BILLING_CREDENTIAL_SET",
      input.installationId,
      "DENIED",
      {},
      "TYPED",
      input.idempotencyKey,
    );
    return { status: "forbidden" };
  }
  const inst = await personalInstallation(actor.scope, input.installationId);
  if (input.confirmation.trim() !== inst.accountLogin)
    return { status: "confirmation_mismatch" };
  const token = input.token.trim();
  if (!isFineGrainedPat(token))
    return {
      status: OTHER_GITHUB_TOKEN.test(token)
        ? "token_too_broad"
        : "invalid_token",
    };

  let owner;
  try {
    owner = await fetchTokenOwner(token, deps.fetch);
  } catch (error) {
    const status = error instanceof GitHubHttpError ? error.status : null;
    return { status: status === 401 ? "invalid_token" : "github_error" };
  }
  if (owner.oauthScopes.length > 0) return { status: "token_too_broad" };
  if (!sameLogin(owner.login, inst.accountLogin)) {
    await audit(
      actor,
      "BILLING_CREDENTIAL_SET",
      inst.id,
      "FAILED",
      { kind: "PAT", githubLogin: owner.login },
      "TYPED",
      input.idempotencyKey,
      "login_mismatch",
    );
    return { status: "login_mismatch", login: owner.login };
  }
  // A connected credential being replaced is revoked at GitHub first; if
  // that fails nothing is replaced, so the old grant can still be revoked.
  const previous = await revokeStoredCredentialAtGitHub(
    inst.id,
    "grant",
    credentialDeps(deps),
  );
  if (previous === "failed") {
    await audit(
      actor,
      "BILLING_CREDENTIAL_SET",
      inst.id,
      "FAILED",
      { kind: "PAT", githubLogin: owner.login, previousRevocation: previous },
      "TYPED",
      input.idempotencyKey,
      "previous_revocation_failed",
    );
    return { status: "revoke_failed" };
  }
  await saveCredential({
    installationId: inst.id,
    kind: "PAT",
    owner,
    tokens: {
      accessToken: token,
      accessTokenExpiresAt: owner.tokenExpiresAt,
      refreshToken: null,
      refreshTokenExpiresAt: null,
    },
    createdByUserId: actor.user.id,
  });
  await audit(
    actor,
    "BILLING_CREDENTIAL_SET",
    inst.id,
    "SUCCEEDED",
    { kind: "PAT", githubLogin: owner.login, previousRevocation: previous },
    "TYPED",
    input.idempotencyKey,
  );
  return { status: "saved", login: owner.login };
}

/** Option B, step 1: the authorize URL (state bound to this admin, PKCE S256). */
export async function startConnect(
  actor: Actor,
  input: { installationId: bigint },
  deps: FlowDeps = defaultDeps(),
): Promise<CredentialActionResult> {
  if (!hasRole(actor.scope.role, "ADMIN")) {
    await audit(
      actor,
      "BILLING_CREDENTIAL_CONNECT",
      input.installationId,
      "DENIED",
      {},
      "NONE",
    );
    return { status: "forbidden" };
  }
  const inst = await personalInstallation(actor.scope, input.installationId);
  const app = appClient();
  if (!connectEnabled() || !app) return { status: "not_configured" };
  const pkce = createPkce();
  const state = randomState();
  await saveConnectState({
    state,
    verifier: pkce.verifier,
    userId: actor.user.id,
    installationId: inst.id,
    now: deps.now(),
  });
  return {
    status: "redirect",
    url: authorizeUrl({
      clientId: app.clientId,
      redirectUri: connectRedirectUri(),
      state,
      codeChallenge: pkce.challenge,
      login: inst.accountLogin,
    }),
  };
}

/** Option B, step 2 (callback): exchange the code, check the login, store encrypted. */
export async function completeConnect(
  actor: Actor,
  input: { code: string; state: string },
  deps: FlowDeps = defaultDeps(),
): Promise<CredentialActionResult> {
  const app = appClient();
  if (!connectEnabled() || !app) return { status: "not_configured" };
  if (!hasRole(actor.scope.role, "ADMIN")) return { status: "forbidden" };
  const pending = await consumeConnectState(
    input.state,
    actor.user.id,
    deps.now(),
  );
  if (!pending) return { status: "invalid_state" };
  const inst = await personalInstallation(actor.scope, pending.installationId);

  let tokens;
  let owner;
  try {
    tokens = await exchangeCode(
      app,
      input.code,
      pending.verifier,
      connectRedirectUri(),
      deps.fetch,
      deps.now(),
    );
    owner = await fetchTokenOwner(tokens.accessToken, deps.fetch);
  } catch (error) {
    const reason =
      error instanceof OAuthError
        ? error.code
        : error instanceof GitHubHttpError
          ? `http_${error.status}`
          : "github_error";
    await audit(
      actor,
      "BILLING_CREDENTIAL_CONNECT",
      inst.id,
      "FAILED",
      { kind: "USER_TO_SERVER" },
      "NONE",
      undefined,
      reason,
    );
    return { status: "github_error" };
  }
  if (!sameLogin(owner.login, inst.accountLogin)) {
    // The authorisation is not needed: give the whole grant back right away.
    await revokeUserGrant(app, tokens.accessToken, deps.fetch).catch(
      () => undefined,
    );
    await audit(
      actor,
      "BILLING_CREDENTIAL_CONNECT",
      inst.id,
      "FAILED",
      { kind: "USER_TO_SERVER", githubLogin: owner.login },
      "NONE",
      undefined,
      "login_mismatch",
    );
    return { status: "login_mismatch", login: owner.login };
  }
  // GitHub keeps earlier user-to-server tokens alive on a new authorisation,
  // so the replaced credential is given back. The same GitHub user shares
  // the grant with the token just obtained: then only the old token pair is
  // revoked, never the grant.
  const old = await storedCredentialOwner(inst.id);
  const previous: RemoteRevocation =
    old?.kind === "USER_TO_SERVER"
      ? await revokeStoredCredentialAtGitHub(
          inst.id,
          old.githubUserId === owner.id ? "token" : "grant",
          { app, fetch: deps.fetch, now: deps.now, envToken: null },
        )
      : "not_needed";
  await saveCredential({
    installationId: inst.id,
    kind: "USER_TO_SERVER",
    owner,
    tokens,
    createdByUserId: actor.user.id,
  });
  await audit(
    actor,
    "BILLING_CREDENTIAL_CONNECT",
    inst.id,
    "SUCCEEDED",
    {
      kind: "USER_TO_SERVER",
      githubLogin: owner.login,
      previousRevocation: previous,
    },
    "NONE",
  );
  return { status: "connected", login: owner.login };
}

/**
 * Revoke: a connected credential is revoked at GitHub as a whole grant
 * (access and refresh tokens), then the stored row is deleted.
 *
 * - GitHub refused or could not be reached: the row stays (with a usable
 *   token) so the admin can retry; "revoke_failed", audited FAILED.
 * - The App's client credentials are not configured: the row is deleted, but
 *   the result is "revoked_locally" and the audit row is FAILED, so nobody is
 *   told the authorisation ended at GitHub.
 */
export async function revokeBillingCredential(
  actor: Actor,
  input: {
    installationId: bigint;
    confirmation: string;
    idempotencyKey?: string;
  },
  deps: FlowDeps = defaultDeps(),
): Promise<CredentialActionResult> {
  if (!hasRole(actor.scope.role, "ADMIN")) {
    await audit(
      actor,
      "BILLING_CREDENTIAL_REVOKE",
      input.installationId,
      "DENIED",
      {},
      "TYPED",
      input.idempotencyKey,
    );
    return { status: "forbidden" };
  }
  const inst = await personalInstallation(actor.scope, input.installationId);
  if (input.confirmation.trim() !== inst.accountLogin)
    return { status: "confirmation_mismatch" };
  const stored = await storedCredentialOwner(inst.id);
  const remote = await revokeStoredCredentialAtGitHub(
    inst.id,
    "grant",
    credentialDeps(deps),
  );
  const params = { kind: stored?.kind ?? null, remoteRevocation: remote };
  if (remote === "failed") {
    await audit(
      actor,
      "BILLING_CREDENTIAL_REVOKE",
      inst.id,
      "FAILED",
      params,
      "TYPED",
      input.idempotencyKey,
      "remote_revocation_failed",
    );
    return { status: "revoke_failed" };
  }
  await deleteCredential(inst.id);
  if (remote === "not_configured") {
    await audit(
      actor,
      "BILLING_CREDENTIAL_REVOKE",
      inst.id,
      "FAILED",
      params,
      "TYPED",
      input.idempotencyKey,
      "remote_revocation_not_configured",
    );
    return { status: "revoked_locally" };
  }
  await audit(
    actor,
    "BILLING_CREDENTIAL_REVOKE",
    inst.id,
    "SUCCEEDED",
    params,
    "TYPED",
    input.idempotencyKey,
  );
  return { status: "revoked" };
}
