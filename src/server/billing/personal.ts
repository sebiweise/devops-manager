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
  OAuthError,
  randomState,
  revokeUserToken,
  sameLogin,
  type AppClient,
  type Fetch,
} from "@/server/github/billing-credential";
import {
  consumeConnectState,
  deleteCredential,
  saveConnectState,
  saveCredential,
  storedAccessToken,
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
 */

export type Actor = {
  user: { id: string; name: string; email: string };
  scope: TenantScope;
};

export type CredentialActionStatus =
  | "saved"
  | "connected"
  | "revoked"
  | "redirect"
  | "forbidden"
  | "confirmation_mismatch"
  | "invalid_token"
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

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,255}$/;

/** Option A: validate a PAT with `GET /user` and store it encrypted. */
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
  if (!TOKEN_SHAPE.test(token)) return { status: "invalid_token" };

  let owner;
  try {
    owner = await fetchTokenOwner(token, deps.fetch);
  } catch (error) {
    const status = error instanceof GitHubHttpError ? error.status : null;
    return { status: status === 401 ? "invalid_token" : "github_error" };
  }
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
    { kind: "PAT", githubLogin: owner.login },
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
    // The authorisation is not needed: give it back right away.
    await revokeUserToken(app, tokens.accessToken, deps.fetch).catch(
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
    { kind: "USER_TO_SERVER", githubLogin: owner.login },
    "NONE",
  );
  return { status: "connected", login: owner.login };
}

/**
 * Revoke: a user-to-server token is also revoked at GitHub
 * (`DELETE /applications/{client_id}/token`); the stored row is deleted.
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
  const stored = await storedAccessToken(inst.id);
  let remote: string = "not_needed";
  if (stored?.kind === "USER_TO_SERVER" && stored.token) {
    const app = appClient();
    if (app) {
      try {
        await revokeUserToken(app, stored.token, deps.fetch);
        remote = "revoked";
      } catch {
        remote = "failed";
      }
    } else remote = "not_configured";
  }
  await deleteCredential(inst.id);
  await audit(
    actor,
    "BILLING_CREDENTIAL_REVOKE",
    inst.id,
    "SUCCEEDED",
    { kind: stored?.kind ?? null, remoteRevocation: remote },
    "TYPED",
    input.idempotencyKey,
  );
  return { status: "revoked" };
}
