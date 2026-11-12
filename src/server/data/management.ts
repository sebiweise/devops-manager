import "server-only";
import { env } from "@/env";
import type { TenantScope } from "@/server/authz/scope";
import { hasRole } from "@/server/authz/roles";
import { db } from "@/server/db";
import {
  parsePresets,
  type VariablePreset,
} from "@/server/management/variable-rules";
import { inScope, NotFoundError } from "./installations";

/**
 * Tenant-scoped lookups and settings for the management actions (design
 * §8). Every function takes a TenantScope; an id outside the scope, or an
 * entity of another installation, throws NotFoundError (404) before any
 * token is minted.
 */

export type ManagementState = {
  installationId: string;
  accountLogin: string;
  accountType: "USER" | "ORGANIZATION";
  /** MANAGEMENT_ENABLED (global kill switch). */
  globalEnabled: boolean;
  /** The installation's own toggle. */
  installationEnabled: boolean;
  /** Both switches on: action buttons may be shown. */
  enabled: boolean;
  redactVariableValues: boolean;
  /** Role-gated UI hints; the server enforces the same rules. */
  canOperate: boolean;
  canAdmin: boolean;
  mergeAuditTrailer: boolean;
  /** Granted App permissions (names and levels only). */
  permissions: Record<string, string>;
};

export async function getManagementState(
  scope: TenantScope,
  installationId: bigint,
): Promise<ManagementState> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const inst = await db.installation.findFirst({
    where: { id: installationId, deletedAt: null, suspendedAt: null },
    select: {
      id: true,
      accountLogin: true,
      accountType: true,
      managementEnabled: true,
      redactVariableValues: true,
      permissions: true,
    },
  });
  if (!inst) throw new NotFoundError();
  const enabled = env.MANAGEMENT_ENABLED && inst.managementEnabled;
  return {
    installationId: String(inst.id),
    accountLogin: inst.accountLogin,
    accountType: inst.accountType,
    globalEnabled: env.MANAGEMENT_ENABLED,
    installationEnabled: inst.managementEnabled,
    enabled,
    redactVariableValues: inst.redactVariableValues,
    canOperate: enabled && hasRole(scope.role, "OPERATOR"),
    canAdmin: enabled && hasRole(scope.role, "ADMIN"),
    mergeAuditTrailer: env.MERGE_AUDIT_TRAILER,
    permissions: Object.fromEntries(
      Object.entries(
        (inst.permissions ?? {}) as Record<string, unknown>,
      ).filter((e): e is [string, string] => typeof e[1] === "string"),
    ),
  };
}

/** The configured runs-on switch presets (VARIABLE_PRESETS or the defaults). */
export function variablePresets(): VariablePreset[] {
  return parsePresets(env.VARIABLE_PRESETS);
}

export type RunTarget = {
  runId: bigint;
  runAttempt: number;
  runNumber: number | null;
  workflowName: string;
  status: string;
  repositoryId: bigint;
  fullName: string;
  ownerLogin: string;
  name: string;
};

/** A stored run of a visible installation, with its repository. */
export async function findRunTarget(
  scope: TenantScope,
  installationId: bigint,
  runId: bigint,
): Promise<RunTarget> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const run = await db.workflowRun.findFirst({
    where: { id: runId, installationId },
    select: {
      id: true,
      runAttempt: true,
      runNumber: true,
      workflowName: true,
      status: true,
      repositoryId: true,
    },
  });
  if (!run) throw new NotFoundError();
  const repo = await db.repository.findFirst({
    where: { id: run.repositoryId, installationId, removedAt: null },
    select: { id: true, fullName: true, ownerLogin: true, name: true },
  });
  if (!repo) throw new NotFoundError();
  return {
    runId: run.id,
    runAttempt: run.runAttempt,
    runNumber: run.runNumber,
    workflowName: run.workflowName,
    status: run.status,
    repositoryId: repo.id,
    fullName: repo.fullName,
    ownerLogin: repo.ownerLogin,
    name: repo.name,
  };
}

export type RepoTarget = {
  id: bigint;
  fullName: string;
  ownerLogin: string;
  name: string;
  archived: boolean;
  /** False once the repo left the installation's repository selection. */
  selected: boolean;
};

/**
 * Repositories of a visible installation by id. Any id that does not belong
 * to the installation (another installation's repo, or unknown) makes the
 * whole call NotFoundError. Repos that left the selection are returned with
 * `selected: false`, so a bulk preview can mark them.
 */
export async function findRepoTargets(
  scope: TenantScope,
  installationId: bigint,
  repositoryIds: readonly bigint[],
): Promise<RepoTarget[]> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const unique = [...new Set(repositoryIds)];
  if (unique.length === 0) return [];
  const rows = await db.repository.findMany({
    where: { id: { in: unique }, installationId },
    select: {
      id: true,
      fullName: true,
      ownerLogin: true,
      name: true,
      archived: true,
      removedAt: true,
    },
    orderBy: { fullName: "asc" },
  });
  if (rows.length !== unique.length) throw new NotFoundError();
  return rows.map((r) => ({
    id: r.id,
    fullName: r.fullName,
    ownerLogin: r.ownerLogin,
    name: r.name,
    archived: r.archived,
    selected: r.removedAt === null,
  }));
}

/** One active repository of a visible installation. */
export async function findRepoTarget(
  scope: TenantScope,
  installationId: bigint,
  repositoryId: bigint,
): Promise<RepoTarget> {
  const [repo] = await findRepoTargets(scope, installationId, [repositoryId]);
  if (!repo || !repo.selected) throw new NotFoundError();
  return repo;
}

/**
 * Active repositories of a visible installation (for matrices and live
 * reads). Ignored repositories are left out (nothing is loaded for them)
 * unless `includeIgnored` is set (audit log filters).
 */
export async function listRepoTargets(
  scope: TenantScope,
  installationId: bigint,
  opts: { includeIgnored?: boolean } = {},
): Promise<RepoTarget[]> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const rows = await db.repository.findMany({
    where: {
      installationId,
      removedAt: null,
      ...(opts.includeIgnored ? {} : { ignoredAt: null }),
    },
    select: {
      id: true,
      fullName: true,
      ownerLogin: true,
      name: true,
      archived: true,
    },
    orderBy: { fullName: "asc" },
  });
  return rows.map((r) => ({ ...r, selected: true }));
}

/** The visible, active installation's account (login and type) and redaction flag. */
export async function findInstallationAccount(
  scope: TenantScope,
  installationId: bigint,
): Promise<{
  id: bigint;
  accountLogin: string;
  accountType: "USER" | "ORGANIZATION";
  permissions: Record<string, unknown>;
  redactVariableValues: boolean;
}> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const inst = await db.installation.findFirst({
    where: { id: installationId, deletedAt: null, suspendedAt: null },
    select: {
      id: true,
      accountLogin: true,
      accountType: true,
      permissions: true,
      redactVariableValues: true,
    },
  });
  if (!inst) throw new NotFoundError();
  return {
    ...inst,
    permissions: (inst.permissions ?? {}) as Record<string, unknown>,
  };
}

/** Writes the per-installation management settings (admin actions only). */
export async function updateManagementSettings(
  scope: TenantScope,
  installationId: bigint,
  patch: { managementEnabled?: boolean; redactVariableValues?: boolean },
): Promise<void> {
  if (!inScope(scope, installationId) || !hasRole(scope.role, "ADMIN"))
    throw new NotFoundError();
  const { count } = await db.installation.updateMany({
    where: { id: installationId, deletedAt: null },
    data: patch,
  });
  if (count !== 1) throw new NotFoundError();
}
