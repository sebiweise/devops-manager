import "server-only";
import { csv, env } from "@/env";
import type { AzureAuth, Fetch } from "@/server/azure/client";
import { EntraError, entraToken } from "@/server/azure/entra";
import { decryptToken, encryptToken } from "@/server/crypto";
import { db } from "@/server/db";
import type { EncryptedColumn } from "./provider-step";
import { scrubKnown } from "./webhook";

/**
 * The only module that decrypts an Azure DevOps credential (design addendum
 * M7 §3, §8). Secrets are AES-256-GCM ciphertext bound to their row and
 * column (AAD "AzureDevOpsConnection:<installationId>:<column>"), decrypted
 * per step or action, never cached across requests (Entra access tokens are
 * cached in memory only, see azure/entra.ts), never logged and never
 * returned to a page.
 *
 * Credential kinds of a connection:
 * - PAT: an organisation-scoped personal access token (Basic auth).
 * - ENTRA_SP: a Microsoft Entra service principal; the stored secret is its
 *   client secret, exchanged for a bearer token per call (client
 *   credentials).
 * - ENV: AZURE_DEVOPS_PAT, or AZURE_DEVOPS_TENANT_ID/_CLIENT_ID/
 *   _CLIENT_SECRET, for the installation of AZURE_DEVOPS_ACCOUNT; never
 *   written to the database.
 */

const LAST_USED_THROTTLE_MS = 10 * 60 * 1000;

export type AzureSecretColumn = "accessToken" | "hookSecret" | "hookSecretPrev";

export function azureAad(
  installationId: bigint,
  column: AzureSecretColumn,
): string {
  return `AzureDevOpsConnection:${installationId}:${column}`;
}

export function encryptAzureSecret(
  installationId: bigint,
  column: AzureSecretColumn,
  value: string,
): string {
  return encryptToken(value, azureAad(installationId, column));
}

export function decryptAzureSecret(
  installationId: bigint,
  column: AzureSecretColumn,
  ciphertext: string,
): string {
  return decryptToken(ciphertext, azureAad(installationId, column));
}

/** The last 4 characters, shown as "…abcd". */
export function secretHintOf(secret: string): string {
  return secret.slice(-4);
}

/** ALLOWED_AZURE_ORGS (names, case-insensitive); unset allows every organisation. */
export function isAllowedAzureOrg(org: string): boolean {
  const allowed = csv(env.ALLOWED_AZURE_ORGS).map((s) => s.toLowerCase());
  return allowed.length === 0 || allowed.includes(org.toLowerCase());
}

export type EnvAzureCredential = {
  org: string;
  accountLogin: string;
} & (
  | { kind: "pat"; pat: string }
  | { kind: "sp"; tenantId: string; clientId: string; clientSecret: string }
);

/** The env credential with its account, or null when not configured. */
export function envAzureCredential(): EnvAzureCredential | null {
  if (!env.AZURE_DEVOPS_ORG || !env.AZURE_DEVOPS_ACCOUNT) return null;
  const base = {
    org: env.AZURE_DEVOPS_ORG,
    accountLogin: env.AZURE_DEVOPS_ACCOUNT,
  };
  if (env.AZURE_DEVOPS_PAT)
    return { ...base, kind: "pat", pat: env.AZURE_DEVOPS_PAT };
  if (
    env.AZURE_DEVOPS_TENANT_ID &&
    env.AZURE_DEVOPS_CLIENT_ID &&
    env.AZURE_DEVOPS_CLIENT_SECRET
  )
    return {
      ...base,
      kind: "sp",
      tenantId: env.AZURE_DEVOPS_TENANT_ID,
      clientId: env.AZURE_DEVOPS_CLIENT_ID,
      clientSecret: env.AZURE_DEVOPS_CLIENT_SECRET,
    };
  return null;
}

/** The plain credential before it becomes an Authorization header. */
export type PlainAzureCredential =
  | { kind: "pat"; pat: string }
  | { kind: "sp"; tenantId: string; clientId: string; clientSecret: string };

/** The Authorization of a plain credential (an Entra token for a service principal). */
export async function authOf(
  cred: PlainAzureCredential,
  opts: { fetch?: Fetch; now?: () => number } = {},
): Promise<{ auth: AzureAuth; secrets: string[] }> {
  if (cred.kind === "pat")
    return { auth: { kind: "basic", pat: cred.pat }, secrets: [cred.pat] };
  const { token } = await entraToken(cred, opts);
  return {
    auth: { kind: "bearer", token },
    secrets: [cred.clientSecret, token],
  };
}

export type AzureCredential =
  | { kind: "none" }
  | { kind: "revoked" }
  /** The connection is ENV-sourced but the env credential is gone or for another account. */
  | { kind: "env_missing" }
  | {
      kind: "token";
      authKind: "PAT" | "ENV" | "ENTRA_SP";
      auth: AzureAuth;
      org: string;
      orgId: string;
      /** Every secret of the call (scrubbed from errors and log excerpts). */
      secrets: string[];
      /** "azure:pat:<hint>" | "azure:env-token" | "azure:sp:<hint>" */
      actingAs: string;
    };

export function actingAsOf(conn: {
  authKind: "PAT" | "ENV" | "ENTRA_SP";
  tokenHint: string | null;
}): string {
  if (conn.authKind === "ENV") return "azure:env-token";
  return `azure:${conn.authKind === "PAT" ? "pat" : "sp"}:${conn.tokenHint ?? "unknown"}`;
}

/**
 * The credential for one Azure DevOps step or action of an installation. A
 * service principal's secret is exchanged for a token here; an EntraError
 * (rejected secret, network) is thrown to the caller, which maps it like a
 * 401 (revoked) or a transient error.
 */
export async function azureCredentialFor(
  installationId: bigint,
  opts: {
    envCredential?: EnvAzureCredential | null;
    fetch?: Fetch;
    now?: () => number;
  } = {},
): Promise<AzureCredential> {
  const envCred =
    opts.envCredential === undefined
      ? envAzureCredential()
      : opts.envCredential;
  const row = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: {
      orgId: true,
      orgName: true,
      authKind: true,
      accessToken: true,
      tokenHint: true,
      tenantId: true,
      clientId: true,
      revokedAt: true,
      installation: { select: { accountLogin: true } },
    },
  });
  if (!row) return { kind: "none" };
  if (row.revokedAt) return { kind: "revoked" };
  const base = {
    kind: "token" as const,
    authKind: row.authKind,
    org: row.orgName,
    orgId: row.orgId,
    actingAs: actingAsOf(row),
  };
  if (row.authKind === "ENV") {
    if (
      !envCred ||
      envCred.accountLogin.toLowerCase() !==
        row.installation.accountLogin.toLowerCase() ||
      envCred.org.toLowerCase() !== row.orgName.toLowerCase()
    )
      return { kind: "env_missing" };
    const { auth, secrets } = await authOf(envCred, opts);
    return { ...base, auth, secrets };
  }
  if (!row.accessToken) return { kind: "revoked" };
  const secret = decryptAzureSecret(
    installationId,
    "accessToken",
    row.accessToken,
  );
  if (row.authKind === "PAT")
    return { ...base, auth: { kind: "basic", pat: secret }, secrets: [secret] };
  if (!row.tenantId || !row.clientId) return { kind: "revoked" };
  const { auth, secrets } = await authOf(
    {
      kind: "sp",
      tenantId: row.tenantId,
      clientId: row.clientId,
      clientSecret: secret,
    },
    opts,
  );
  return { ...base, auth, secrets };
}

/** True for an EntraError that means the secret no longer works. */
export function entraRevoked(error: unknown): boolean {
  return error instanceof EntraError && error.revoked;
}

/** A 401, 203 or rejected secret: sync stops until the admin rotates the credential. */
export async function markAzureRevoked(
  installationId: bigint,
  reason: string,
  now: Date,
  secrets: ReadonlyArray<string | null | undefined> = [],
): Promise<void> {
  const conn = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: { orgName: true },
  });
  await db.azureDevOpsConnection.updateMany({
    where: { installationId, revokedAt: null },
    data: {
      revokedAt: now,
      lastSyncStatus: "credential_error",
      lastSyncedAt: now,
      lastError: scrubKnown(reason, [...secrets, conn?.orgName], 300),
    },
  });
}

/** Records a successful use, at most once per 10 minutes (keeps the PAT active). */
export async function touchAzureUse(
  installationId: bigint,
  now: Date,
): Promise<void> {
  await db.azureDevOpsConnection.updateMany({
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

/** The k2 registry entry of the Azure DevOps secrets. */
export const azureEncryptedColumns: EncryptedColumn = {
  label: "Azure DevOps secret",
  async load(after) {
    const rows = await db.azureDevOpsConnection.findMany({
      where: {
        OR: [
          { accessToken: { not: null } },
          { hookSecret: { not: null } },
          { hookSecretPrev: { not: null } },
        ],
        ...(after === undefined ? {} : { installationId: { gt: after } }),
      },
      orderBy: { installationId: "asc" },
      take: 50,
      select: {
        installationId: true,
        accessToken: true,
        hookSecret: true,
        hookSecretPrev: true,
      },
    });
    return rows.map((r) => ({
      id: r.installationId,
      values: {
        accessToken: r.accessToken,
        hookSecret: r.hookSecret,
        hookSecretPrev: r.hookSecretPrev,
      },
    }));
  },
  aad: (id, column) => azureAad(id, column as AzureSecretColumn),
  async save(id, before, after) {
    await db.azureDevOpsConnection.updateMany({
      where: {
        installationId: id,
        accessToken: before.accessToken,
        hookSecret: before.hookSecret,
        hookSecretPrev: before.hookSecretPrev,
      },
      data: after,
    });
  },
};
