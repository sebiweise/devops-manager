import "server-only";
import { env } from "@/env";
import type { TenantScope } from "@/server/authz/scope";
import { hasRole } from "@/server/authz/roles";
import { db } from "@/server/db";
import { inScope, NotFoundError } from "./installations";

/**
 * Personal-account billing credential status for /admin/github (design §3.4,
 * §7). Admin only: other roles get NotFoundError (admin pages answer 404).
 * The DTOs never contain a token, only its kind, owner and expiry.
 */

const WARN_BEFORE_MS = 14 * 86_400_000;

export type CredentialState =
  "none" | "env" | "pat" | "connected" | "reconnect";

export type BillingCredentialStatus = {
  installationId: string;
  accountLogin: string;
  state: CredentialState;
  githubLogin: string | null;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  /** The stored PAT (or the 6-month refresh token) expires within 14 days. */
  expiringSoon: boolean;
  lastUsedAt: string | null;
  lastError: string | null;
  billingStatus: string | null;
  billingSyncedAt: string | null;
};

export type BillingCredentialOverview = {
  /** "Connect GitHub" (option B) is configured. */
  connectEnabled: boolean;
  installations: BillingCredentialStatus[];
};

function assertAdmin(scope: TenantScope) {
  if (!hasRole(scope.role, "ADMIN")) throw new NotFoundError();
}

export function connectEnabled(): boolean {
  return (
    env.GITHUB_CONNECT_ENABLED &&
    !!env.GITHUB_APP_CLIENT_ID &&
    !!env.GITHUB_APP_CLIENT_SECRET
  );
}

export async function listBillingCredentials(
  scope: TenantScope,
  now: Date = new Date(),
): Promise<BillingCredentialOverview> {
  assertAdmin(scope);
  const personal = await db.installation.findMany({
    where: {
      id: { in: scope.installationIds },
      accountType: "USER",
      deletedAt: null,
      suspendedAt: null,
    },
    orderBy: { accountLogin: "asc" },
    select: {
      id: true,
      accountLogin: true,
      billingStatus: true,
      billingSyncedAt: true,
    },
  });
  const rows = await db.gitHubCredential.findMany({
    where: { installationId: { in: personal.map((p) => p.id) } },
    select: {
      installationId: true,
      kind: true,
      githubLogin: true,
      accessToken: true,
      accessTokenExpiresAt: true,
      refreshTokenExpiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      lastError: true,
    },
  });
  const byId = new Map(rows.map((c) => [c.installationId, c]));
  // The env token covers the single personal installation only.
  const allPersonal = await db.installation.count({
    where: { accountType: "USER", deletedAt: null, suspendedAt: null },
  });
  const envApplies = !!env.GITHUB_BILLING_TOKEN && allPersonal === 1;
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

  return {
    connectEnabled: connectEnabled(),
    installations: personal.map((p) => {
      const c = byId.get(p.id);
      let state: CredentialState = "none";
      if (envApplies) state = "env";
      else if (c && (c.revokedAt || !c.accessToken)) state = "reconnect";
      else if (c) state = c.kind === "PAT" ? "pat" : "connected";
      const expiry =
        c?.kind === "PAT" ? c.accessTokenExpiresAt : c?.refreshTokenExpiresAt;
      return {
        installationId: String(p.id),
        accountLogin: p.accountLogin,
        state,
        githubLogin: state === "env" ? null : (c?.githubLogin ?? null),
        accessTokenExpiresAt: iso(c?.accessTokenExpiresAt),
        refreshTokenExpiresAt: iso(c?.refreshTokenExpiresAt),
        expiringSoon:
          state !== "env" &&
          !!expiry &&
          expiry.getTime() - now.getTime() < WARN_BEFORE_MS,
        lastUsedAt: iso(c?.lastUsedAt),
        lastError: c?.lastError ?? null,
        billingStatus: p.billingStatus,
        billingSyncedAt: iso(p.billingSyncedAt),
      };
    }),
  };
}

/**
 * The visible, active personal installation an admin acts on, or
 * NotFoundError (organisations use the installation token, not a credential).
 */
export async function personalInstallation(
  scope: TenantScope,
  installationId: bigint,
): Promise<{ id: bigint; accountLogin: string }> {
  assertAdmin(scope);
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const inst = await db.installation.findFirst({
    where: {
      id: installationId,
      accountType: "USER",
      deletedAt: null,
      suspendedAt: null,
    },
    select: { id: true, accountLogin: true },
  });
  if (!inst) throw new NotFoundError();
  return inst;
}
