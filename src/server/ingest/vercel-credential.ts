import "server-only";
import { csv, env } from "@/env";
import { decryptToken, encryptToken, tokenKeyRing } from "@/server/crypto";
import { db } from "@/server/db";
import { redactError, scrubKnown } from "./webhook";

/**
 * The only module that decrypts a Vercel token (design addendum §5.3).
 * Tokens are AES-256-GCM ciphertext bound to their row and column (AAD
 * "VercelConnection:<installationId>:accessToken"), decrypted per step and
 * never cached across requests, never logged, never returned to a page.
 *
 * Sources: the stored token of the connection (DB), or VERCEL_TOKEN from env
 * for the installation of VERCEL_ACCOUNT (ENV; never written to the DB).
 */

const LAST_USED_THROTTLE_MS = 10 * 60 * 1000;

export function vercelTokenAad(installationId: bigint): string {
  return `VercelConnection:${installationId}:accessToken`;
}

export function encryptVercelToken(
  installationId: bigint,
  token: string,
): string {
  return encryptToken(token, vercelTokenAad(installationId));
}

/** The last 4 characters, shown as "…abcd". */
export function tokenHintOf(token: string): string {
  return token.slice(-4);
}

/** ALLOWED_VERCEL_TEAMS (ids or slugs, case-insensitive); unset allows every team. */
export function isAllowedVercelTeam(team: { id: string; slug: string }) {
  const allowed = csv(env.ALLOWED_VERCEL_TEAMS).map((s) => s.toLowerCase());
  if (allowed.length === 0) return true;
  return (
    allowed.includes(team.id.toLowerCase()) ||
    allowed.includes(team.slug.toLowerCase())
  );
}

export type EnvVercelToken = {
  token: string;
  teamId: string | null;
  accountLogin: string;
};

/** VERCEL_TOKEN with its account, or null when not configured. */
export function envVercelToken(): EnvVercelToken | null {
  if (!env.VERCEL_TOKEN || !env.VERCEL_ACCOUNT) return null;
  return {
    token: env.VERCEL_TOKEN,
    teamId: env.VERCEL_TEAM_ID ?? null,
    accountLogin: env.VERCEL_ACCOUNT,
  };
}

export type VercelCredential =
  | { kind: "none" }
  | { kind: "revoked" }
  /** The connection is ENV-sourced but VERCEL_TOKEN is not set (any more). */
  | { kind: "env_missing" }
  | {
      kind: "token";
      source: "DB" | "ENV";
      token: string;
      teamId: string;
    };

/** The token for one Vercel step of an installation. */
export async function vercelCredentialFor(
  installationId: bigint,
  envToken: EnvVercelToken | null = envVercelToken(),
): Promise<VercelCredential> {
  const row = await db.vercelConnection.findUnique({
    where: { installationId },
    select: {
      teamId: true,
      tokenSource: true,
      accessToken: true,
      revokedAt: true,
      installation: { select: { accountLogin: true } },
    },
  });
  if (!row) return { kind: "none" };
  if (row.revokedAt) return { kind: "revoked" };
  if (row.tokenSource === "ENV") {
    if (
      !envToken ||
      envToken.accountLogin.toLowerCase() !==
        row.installation.accountLogin.toLowerCase()
    )
      return { kind: "env_missing" };
    return {
      kind: "token",
      source: "ENV",
      token: envToken.token,
      teamId: row.teamId,
    };
  }
  if (!row.accessToken) return { kind: "revoked" };
  return {
    kind: "token",
    source: "DB",
    token: decryptToken(row.accessToken, vercelTokenAad(installationId)),
    teamId: row.teamId,
  };
}

/** A 401 or a token-related 403: sync stops until the admin rotates the token. */
export async function markVercelRevoked(
  installationId: bigint,
  reason: string,
  now: Date,
  token?: string,
): Promise<void> {
  await db.vercelConnection.updateMany({
    where: { installationId, revokedAt: null },
    data: {
      revokedAt: now,
      lastSyncStatus: "credential_error",
      lastSyncedAt: now,
      lastError: scrubKnown(reason, [token], 300),
    },
  });
}

/** Records a successful use, at most once per 10 minutes. */
export async function touchVercelUse(
  installationId: bigint,
  now: Date,
): Promise<void> {
  await db.vercelConnection.updateMany({
    where: {
      installationId,
      OR: [
        { lastUsedAt: null },
        { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_THROTTLE_MS) } },
      ],
    },
    data: { lastUsedAt: now },
  });
}

/**
 * Re-encrypt step "k2": stored tokens (GitHubCredential access and refresh
 * tokens, VercelConnection access tokens) encrypted with a key other than the
 * current one are encrypted again, 50 rows per batch, until done or the
 * deadline. A row that fails to decrypt is left as is (and logged without
 * its value).
 */
export async function reencryptStoredTokens(
  expired: () => boolean,
): Promise<{ reencrypted: number; failed: number }> {
  const ring = tokenKeyRing();
  let reencrypted = 0;
  let failed = 0;
  const redo = (ciphertext: string, aad: string): string | null => {
    if (!ring.needsReencrypt(ciphertext)) return null;
    return ring.encrypt(ring.decrypt(ciphertext, aad), aad);
  };

  let after: bigint | undefined;
  for (;;) {
    if (expired()) return { reencrypted, failed };
    const rows: Array<{
      installationId: bigint;
      accessToken: string | null;
      refreshToken: string | null;
    }> = await db.gitHubCredential.findMany({
      where: after === undefined ? {} : { installationId: { gt: after } },
      orderBy: { installationId: "asc" },
      take: 50,
      select: { installationId: true, accessToken: true, refreshToken: true },
    });
    if (rows.length === 0) break;
    for (const r of rows) {
      try {
        const access = r.accessToken
          ? redo(
              r.accessToken,
              `GitHubCredential:${r.installationId}:accessToken`,
            )
          : null;
        const refresh = r.refreshToken
          ? redo(
              r.refreshToken,
              `GitHubCredential:${r.installationId}:refreshToken`,
            )
          : null;
        if (access || refresh) {
          // Only rows that still hold the value just read are rewritten.
          await db.gitHubCredential.updateMany({
            where: {
              installationId: r.installationId,
              accessToken: r.accessToken,
              refreshToken: r.refreshToken,
            },
            data: {
              ...(access ? { accessToken: access } : {}),
              ...(refresh ? { refreshToken: refresh } : {}),
            },
          });
          reencrypted++;
        }
      } catch (error) {
        failed++;
        console.warn(
          "re-encrypt skipped a billing credential",
          redactError(error instanceof Error ? error.message : "unknown", 120),
        );
      }
    }
    after = rows[rows.length - 1]!.installationId;
  }

  after = undefined;
  for (;;) {
    if (expired()) return { reencrypted, failed };
    const rows: Array<{ installationId: bigint; accessToken: string | null }> =
      await db.vercelConnection.findMany({
        where: {
          accessToken: { not: null },
          ...(after === undefined ? {} : { installationId: { gt: after } }),
        },
        orderBy: { installationId: "asc" },
        take: 50,
        select: { installationId: true, accessToken: true },
      });
    if (rows.length === 0) break;
    for (const r of rows) {
      try {
        const next = redo(r.accessToken!, vercelTokenAad(r.installationId));
        if (next) {
          await db.vercelConnection.updateMany({
            where: {
              installationId: r.installationId,
              accessToken: r.accessToken,
            },
            data: { accessToken: next },
          });
          reencrypted++;
        }
      } catch (error) {
        failed++;
        console.warn(
          "re-encrypt skipped a Vercel token",
          redactError(error instanceof Error ? error.message : "unknown", 120),
        );
      }
    }
    after = rows[rows.length - 1]!.installationId;
  }
  return { reencrypted, failed };
}
