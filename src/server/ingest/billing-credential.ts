import "server-only";
import { createHash } from "node:crypto";
import { env } from "@/env";
import { decryptToken, encryptToken } from "@/server/crypto";
import { db } from "@/server/db";
import {
  GitHubHttpError,
  OAuthError,
  refreshUserToken,
  revokeUserGrant,
  revokeUserToken,
  type AppClient,
  type Fetch,
  type GitHubUser,
  type UserTokenSet,
} from "@/server/github/billing-credential";
import { redactError } from "./webhook";

/**
 * Storage of the optional personal-account billing credential (design §3.4,
 * §9). Tokens are encrypted with the instance key ring and bound to their row
 * and column (AAD), so a ciphertext copied elsewhere does not decrypt. They
 * are decrypted only here, only for the billing step, and never logged.
 *
 * Precedence: GITHUB_BILLING_TOKEN from env (never written to the DB) for the
 * single personal installation, then the stored GitHubCredential row.
 */

/** Refresh a user-to-server token this long before it expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const RECONNECT_REQUIRED = "reconnect_required";

export function credentialAad(
  installationId: bigint,
  column: "accessToken" | "refreshToken",
): string {
  return `GitHubCredential:${installationId}:${column}`;
}

export type CredentialDeps = {
  /** The App's OAuth client (refresh, revoke); null when not configured. */
  app: AppClient | null;
  fetch: Fetch;
  now: () => Date;
  /** GITHUB_BILLING_TOKEN, if set. */
  envToken: string | null;
};

export function credentialDepsFromEnv(): CredentialDeps {
  return {
    app:
      env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET
        ? {
            clientId: env.GITHUB_APP_CLIENT_ID,
            clientSecret: env.GITHUB_APP_CLIENT_SECRET,
          }
        : null,
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    envToken: env.GITHUB_BILLING_TOKEN ?? null,
  };
}

export type BillingToken =
  | { kind: "none" }
  | { kind: "reconnect"; reason: string }
  | { kind: "token"; source: "env" | "PAT" | "USER_TO_SERVER"; token: string };

/**
 * The env token applies to the single active personal installation only;
 * with several personal installations each needs a stored credential.
 */
async function envTokenApplies(installationId: bigint): Promise<boolean> {
  const personal = await db.installation.findMany({
    where: { accountType: "USER", deletedAt: null, suspendedAt: null },
    select: { id: true },
    take: 2,
  });
  return personal.length === 1 && personal[0]!.id === installationId;
}

function encryptSet(installationId: bigint, set: UserTokenSet) {
  return {
    accessToken: encryptToken(
      set.accessToken,
      credentialAad(installationId, "accessToken"),
    ),
    accessTokenExpiresAt: set.accessTokenExpiresAt,
    refreshToken: set.refreshToken
      ? encryptToken(
          set.refreshToken,
          credentialAad(installationId, "refreshToken"),
        )
      : null,
    refreshTokenExpiresAt: set.refreshTokenExpiresAt,
  };
}

/**
 * The token for the billing step of a personal installation. A
 * user-to-server token close to expiry is refreshed inside one transaction
 * that holds the row lock: the rotated refresh token is persisted in the same
 * transaction, and a concurrent caller waits and then sees the new token
 * instead of spending the already-invalidated refresh token. A rejected or
 * expired refresh token marks the credential "reconnect required".
 */
export async function billingTokenFor(
  installationId: bigint,
  deps: CredentialDeps = credentialDepsFromEnv(),
): Promise<BillingToken> {
  if (deps.envToken && (await envTokenApplies(installationId)))
    return { kind: "token", source: "env", token: deps.envToken };

  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "GitHubCredential" WHERE "installationId" = ${installationId} FOR UPDATE`;
      const row = await tx.gitHubCredential.findUnique({
        where: { installationId },
      });
      if (!row) return { kind: "none" } as const;
      if (row.revokedAt || !row.accessToken)
        return {
          kind: "reconnect",
          reason: row.lastError ?? RECONNECT_REQUIRED,
        } as const;
      const now = deps.now();

      if (row.kind === "PAT") {
        if (
          row.accessTokenExpiresAt &&
          row.accessTokenExpiresAt.getTime() <= now.getTime()
        ) {
          await tx.gitHubCredential.update({
            where: { installationId },
            data: { lastError: "token_expired" },
          });
          return { kind: "reconnect", reason: "token_expired" } as const;
        }
        return {
          kind: "token",
          source: "PAT",
          token: decryptToken(
            row.accessToken,
            credentialAad(installationId, "accessToken"),
          ),
        } as const;
      }

      const fresh =
        !row.accessTokenExpiresAt ||
        row.accessTokenExpiresAt.getTime() - REFRESH_MARGIN_MS > now.getTime();
      if (fresh) {
        return {
          kind: "token",
          source: "USER_TO_SERVER",
          token: decryptToken(
            row.accessToken,
            credentialAad(installationId, "accessToken"),
          ),
        } as const;
      }

      const refreshExpired =
        row.refreshTokenExpiresAt != null &&
        row.refreshTokenExpiresAt.getTime() <= now.getTime();
      if (!row.refreshToken || refreshExpired || !deps.app) {
        const reason = !deps.app
          ? "connect_not_configured"
          : RECONNECT_REQUIRED;
        await tx.gitHubCredential.update({
          where: { installationId },
          data: { lastError: reason },
        });
        return { kind: "reconnect", reason } as const;
      }

      let set: UserTokenSet;
      try {
        set = await refreshUserToken(
          deps.app,
          decryptToken(
            row.refreshToken,
            credentialAad(installationId, "refreshToken"),
          ),
          deps.fetch,
          now,
        );
      } catch (error) {
        if (error instanceof OAuthError && error.reconnectRequired) {
          await tx.gitHubCredential.update({
            where: { installationId },
            data: {
              revokedAt: now,
              accessToken: null,
              refreshToken: null,
              lastError: RECONNECT_REQUIRED,
            },
          });
          return { kind: "reconnect", reason: RECONNECT_REQUIRED } as const;
        }
        throw error;
      }
      await tx.gitHubCredential.update({
        where: { installationId },
        data: {
          ...encryptSet(installationId, {
            ...set,
            // GitHub always rotates; keep the old expiry only if it did not say.
            refreshTokenExpiresAt:
              set.refreshTokenExpiresAt ?? row.refreshTokenExpiresAt,
          }),
          lastRefreshedAt: now,
          lastError: null,
        },
      });
      return {
        kind: "token",
        source: "USER_TO_SERVER",
        token: set.accessToken,
      } as const;
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}

/** Records the outcome of a billing call made with the stored credential. */
export async function recordCredentialUse(
  installationId: bigint,
  outcome: { ok: true } | { ok: false; error: string },
  now: Date = new Date(),
): Promise<void> {
  await db.gitHubCredential.updateMany({
    where: { installationId },
    data: outcome.ok
      ? { lastUsedAt: now, lastError: null }
      : { lastError: redactError(outcome.error, 200) },
  });
}

/** Stores (or replaces) the credential of a personal installation, encrypted. */
export async function saveCredential(input: {
  installationId: bigint;
  kind: "PAT" | "USER_TO_SERVER";
  owner: GitHubUser;
  tokens: UserTokenSet;
  createdByUserId: string;
}): Promise<void> {
  const data = {
    kind: input.kind,
    githubUserId: input.owner.id,
    githubLogin: input.owner.login,
    ...encryptSet(input.installationId, input.tokens),
    createdByUserId: input.createdByUserId,
    revokedAt: null,
    lastError: null,
    lastUsedAt: null,
    lastRefreshedAt: null,
  };
  await db.gitHubCredential.upsert({
    where: { installationId: input.installationId },
    create: { installationId: input.installationId, ...data },
    update: data,
  });
  await billingDueNow(input.installationId);
}

/** A changed credential makes the billing sync due on the next reconcile. */
async function billingDueNow(installationId: bigint) {
  await db.installation.updateMany({
    where: { id: installationId },
    data: { billingSyncedAt: null },
  });
}

/** Kind and GitHub user of the stored credential; null when there is none. */
export async function storedCredentialOwner(
  installationId: bigint,
): Promise<{ kind: "PAT" | "USER_TO_SERVER"; githubUserId: bigint } | null> {
  return db.gitHubCredential.findUnique({
    where: { installationId },
    select: { kind: true, githubUserId: true },
  });
}

/**
 * What happened at GitHub when a stored credential was given back:
 * - "revoked": GitHub confirmed the revocation;
 * - "already_gone": no token of it can be used any more (expired, rejected
 *   refresh token, or GitHub answered 404);
 * - "not_needed": nothing to revoke (no row, a PAT, or tokens already wiped);
 * - "not_configured": the App's client id/secret are missing;
 * - "failed": GitHub refused or could not be reached; the row keeps a usable
 *   (possibly rotated) token so the revocation can be retried.
 */
export type RemoteRevocation =
  "revoked" | "already_gone" | "not_needed" | "not_configured" | "failed";

/**
 * Revokes a stored user-to-server credential at GitHub (design §3.4).
 *
 * The access token lives eight hours and the refresh token six months, so
 * revoking only the stored access token would usually hit an expired token
 * and leave the refresh token alive. Instead a live access token is used to
 * identify the authorisation: the stored one while it is valid, otherwise a
 * fresh one from the refresh token (rotation persisted in the same row lock
 * as billingTokenFor, so a failed revocation can be retried).
 *
 * - `mode: "grant"` revokes the whole authorisation
 *   (`DELETE /applications/{client_id}/grant`): every access and refresh
 *   token of that GitHub user for the App.
 * - `mode: "token"` revokes only that token pair
 *   (`DELETE /applications/{client_id}/token`); used when the same GitHub
 *   user has just connected again, whose new token shares the grant.
 *
 * Tokens are never logged; the row is not deleted here.
 */
export async function revokeStoredCredentialAtGitHub(
  installationId: bigint,
  mode: "grant" | "token",
  deps: CredentialDeps = credentialDepsFromEnv(),
): Promise<RemoteRevocation> {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "GitHubCredential" WHERE "installationId" = ${installationId} FOR UPDATE`;
      const row = await tx.gitHubCredential.findUnique({
        where: { installationId },
      });
      if (!row || row.kind !== "USER_TO_SERVER") return "not_needed";
      if (!row.accessToken && !row.refreshToken) return "not_needed";
      if (!deps.app) return "not_configured";
      const app = deps.app;
      const now = deps.now();
      const revoke = (token: string) =>
        mode === "grant"
          ? revokeUserGrant(app, token, deps.fetch)
          : revokeUserToken(app, token, deps.fetch);

      try {
        const accessLive =
          row.accessToken != null &&
          (!row.accessTokenExpiresAt ||
            row.accessTokenExpiresAt.getTime() - REFRESH_MARGIN_MS >
              now.getTime());
        if (accessLive) {
          const outcome = await revoke(
            decryptToken(
              row.accessToken!,
              credentialAad(installationId, "accessToken"),
            ),
          );
          if (outcome === "revoked") return "revoked";
          // 404 for a token we thought live: the refresh token may still work.
        }

        const refreshUsable =
          row.refreshToken != null &&
          (row.refreshTokenExpiresAt == null ||
            row.refreshTokenExpiresAt.getTime() > now.getTime());
        if (!refreshUsable) return "already_gone";

        let set: UserTokenSet;
        try {
          set = await refreshUserToken(
            app,
            decryptToken(
              row.refreshToken!,
              credentialAad(installationId, "refreshToken"),
            ),
            deps.fetch,
            now,
          );
        } catch (error) {
          if (error instanceof OAuthError && error.reconnectRequired)
            return "already_gone";
          throw error;
        }
        // Persist the rotation first: the old refresh token is spent now.
        await tx.gitHubCredential.update({
          where: { installationId },
          data: {
            ...encryptSet(installationId, {
              ...set,
              refreshTokenExpiresAt:
                set.refreshTokenExpiresAt ?? row.refreshTokenExpiresAt,
            }),
            lastRefreshedAt: now,
          },
        });
        const outcome = await revoke(set.accessToken);
        return outcome === "revoked" ? "revoked" : "already_gone";
      } catch (error) {
        if (
          error instanceof GitHubHttpError ||
          error instanceof OAuthError ||
          error instanceof TypeError ||
          (error instanceof Error && error.name === "TimeoutError")
        )
          return "failed";
        throw error;
      }
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

export async function deleteCredential(installationId: bigint): Promise<void> {
  await db.gitHubCredential.deleteMany({ where: { installationId } });
  await billingDueNow(installationId);
}

/**
 * `github_app_authorization.revoked`: the GitHub user revoked the App. Their
 * user-to-server credentials stop working; the tokens are wiped and admins
 * see "reconnect".
 */
export async function revokeCredentialsOfGitHubUser(
  githubUserId: bigint,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await db.gitHubCredential.updateMany({
    where: { githubUserId, kind: "USER_TO_SERVER", revokedAt: null },
    data: {
      revokedAt: now,
      accessToken: null,
      refreshToken: null,
      lastError: RECONNECT_REQUIRED,
    },
  });
  return count;
}

// ---------- "Connect GitHub" state (option B) ----------

const CONNECT_STATE_MS = 10 * 60 * 1000;
const stateKey = (state: string) =>
  `github-connect:${createHash("sha256").update(state).digest("hex")}`;

/**
 * Remembers a started "Connect GitHub" flow: the state is bound to the admin
 * who started it and to the installation, the PKCE verifier is stored
 * encrypted, and the record expires after ten minutes. Only a hash of the
 * state is used as the key.
 */
export async function saveConnectState(input: {
  state: string;
  verifier: string;
  userId: string;
  installationId: bigint;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const key = stateKey(input.state);
  const value = {
    userId: input.userId,
    installationId: String(input.installationId),
    verifier: encryptToken(input.verifier, key),
    expiresAt: new Date(now.getTime() + CONNECT_STATE_MS).toISOString(),
  };
  await db.appState.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  // Expired flows of anyone are dropped on the way.
  await db.$executeRaw`
    DELETE FROM "AppState"
    WHERE "key" LIKE 'github-connect:%' AND ("value"->>'expiresAt')::timestamptz < ${now}`;
}

/**
 * Consumes a "Connect GitHub" state (one use only). Null when it is unknown,
 * expired, or was started by another app user.
 */
export async function consumeConnectState(
  state: string,
  userId: string,
  now: Date = new Date(),
): Promise<{ installationId: bigint; verifier: string } | null> {
  const key = stateKey(state);
  const rows = await db.$queryRaw<Array<{ value: unknown }>>`
    DELETE FROM "AppState" WHERE "key" = ${key} RETURNING "value"`;
  const value = rows[0]?.value as
    | {
        userId?: string;
        installationId?: string;
        verifier?: string;
        expiresAt?: string;
      }
    | undefined;
  if (!value?.verifier || !value.installationId || !value.expiresAt)
    return null;
  if (value.userId !== userId) return null;
  if (Date.parse(value.expiresAt) < now.getTime()) return null;
  return {
    installationId: BigInt(value.installationId),
    verifier: decryptToken(value.verifier, key),
  };
}
