import "server-only";
import { db } from "@/server/db";
import type { TenantScope } from "@/server/authz/scope";

/**
 * Tenant-scoped reads of installations and repositories. Every function takes
 * a `TenantScope` and never returns rows of an installation outside
 * `scope.installationIds`. Callers turn `null` into a 404 (not 403), so
 * account slugs cannot be enumerated.
 *
 * The Prisma client is a parameter so the isolation rules are unit-tested
 * against an in-memory client.
 */

export type InstallationRow = {
  id: bigint;
  accountLogin: string;
  accountType: "USER" | "ORGANIZATION";
  repositorySelection: "ALL" | "SELECTED";
  permissions: unknown;
  suspendedAt: Date | null;
  deletedAt: Date | null;
  lastWebhookAt: Date | null;
  lastReconciledAt: Date | null;
};

export type RepositoryRow = {
  id: bigint;
  installationId: bigint;
  fullName: string;
  name: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  removedAt: Date | null;
};

type Where = Record<string, unknown>;

export interface DataClient {
  installation: {
    findMany(args: {
      where: Where;
      orderBy?: unknown;
    }): Promise<InstallationRow[]>;
    findFirst(args: { where: Where }): Promise<InstallationRow | null>;
  };
  repository: {
    findMany(args: {
      where: Where;
      orderBy?: unknown;
    }): Promise<RepositoryRow[]>;
  };
}

const defaultClient = () => db as unknown as DataClient;

export class NotFoundError extends Error {
  constructor(what = "Not found") {
    super(what);
    this.name = "NotFoundError";
  }
}

export function inScope(scope: TenantScope, installationId: bigint): boolean {
  return scope.installationIds.some((id) => id === installationId);
}

/** Where clause shared by every installation read. */
export function scopedInstallationWhere(scope: TenantScope): Where {
  return {
    id: { in: scope.installationIds },
    deletedAt: null,
    suspendedAt: null,
  };
}

export async function listInstallations(
  scope: TenantScope,
  client: DataClient = defaultClient(),
): Promise<InstallationRow[]> {
  if (scope.installationIds.length === 0) return [];
  return client.installation.findMany({
    where: scopedInstallationWhere(scope),
    orderBy: [{ accountType: "asc" }, { accountLogin: "asc" }],
  });
}

/** The installation for an `[account]` slug, or null when it is not visible. */
export async function findInstallationByAccount(
  scope: TenantScope,
  accountLogin: string,
  client: DataClient = defaultClient(),
): Promise<InstallationRow | null> {
  if (scope.installationIds.length === 0) return null;
  return client.installation.findFirst({
    where: {
      ...scopedInstallationWhere(scope),
      accountLogin: { equals: accountLogin, mode: "insensitive" },
    },
  });
}

/** Active repositories of a visible installation; throws NotFoundError otherwise. */
export async function listRepositories(
  scope: TenantScope,
  installationId: bigint,
  client: DataClient = defaultClient(),
): Promise<RepositoryRow[]> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  return client.repository.findMany({
    where: { installationId, removedAt: null },
    orderBy: [{ fullName: "asc" }],
  });
}
