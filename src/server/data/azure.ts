import "server-only";
import { Prisma } from "@/generated/prisma/client";
import {
  billingMonth,
  limitDay,
  projectWindow,
  quotaLevel,
  usageNote,
  type QuotaLevel,
} from "@/lib/azure-usage";
import { pipelineSummary, type PipelineSummary } from "@/lib/azure-view";
import type { Page } from "@/lib/paging";
import type { InsightRange } from "@/lib/range";
import { hasRole } from "@/server/authz/roles";
import type { TenantScope } from "@/server/authz/scope";
import {
  azureBuildUrl,
  azureDefinitionUrl,
  azureOrgUrl,
} from "@/server/azure/client";
import { db } from "@/server/db";
import { missingOf } from "@/server/github/purposes";
import { localDay, rangeWindow } from "@/server/metrics/days";
import { percentileExact } from "@/server/metrics/stats";
import { inScope, NotFoundError } from "./installations";

/**
 * Tenant-scoped reads and local writes of the Azure Pipelines data (design
 * addendum M7 §6). Every function takes a TenantScope and an installation
 * id and throws NotFoundError outside the scope, before any data is read;
 * a project, definition, build or repository of another installation is
 * NotFound as well. DTOs carry ids as strings and times as ISO strings,
 * never a credential (only its last 4 characters for admins).
 */

const DAY_MS = 86_400_000;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function guard(scope: TenantScope, installationId: bigint) {
  if (!inScope(scope, installationId)) throw new NotFoundError();
}

async function activeInstallation(installationId: bigint) {
  const inst = await db.installation.findFirst({
    where: { id: installationId, deletedAt: null, suspendedAt: null },
    select: {
      id: true,
      accountLogin: true,
      timezone: true,
      permissions: true,
      events: true,
      managementEnabled: true,
    },
  });
  if (!inst) throw new NotFoundError();
  return inst;
}

/** Definitions whose effective repository is `repositoryId`. */
function linkedTo(
  repositoryId: bigint,
): Prisma.AzurePipelineDefinitionWhereInput {
  return {
    OR: [
      { manualRepositoryId: repositoryId },
      { manualRepositoryId: null, repositoryId },
    ],
  };
}

const effectiveRepo = (d: {
  repositoryId: bigint | null;
  manualRepositoryId: bigint | null;
}) => d.manualRepositoryId ?? d.repositoryId;

async function repoNames(
  installationId: bigint,
  ids: ReadonlyArray<bigint | null>,
): Promise<Map<bigint, string>> {
  const unique = [...new Set(ids.filter((i): i is bigint => i !== null))];
  if (unique.length === 0) return new Map();
  const rows = await db.repository.findMany({
    where: {
      id: { in: unique },
      installationId,
      ignoredAt: null,
      removedAt: null,
    },
    select: { id: true, fullName: true },
  });
  return new Map(rows.map((r) => [r.id, r.fullName]));
}

// ---------- connection ----------

export type AzureSummary = {
  connected: true;
  orgName: string;
  authKind: "PAT" | "ENV" | "ENTRA_SP";
  revoked: boolean;
  lastSyncStatus: string | null;
  lastSyncedAt: string | null;
  tokenExpiresAt: string | null;
  pausedUntil: string | null;
  managementEnabled: boolean;
  /** Projects whose backfill is still running. */
  backfilling: number;
  /** Days of history still to backfill (largest of the projects). */
  backfillDaysLeft: number | null;
};

/** What every role may know about the connection (nav, banners); null = none. */
export async function getAzureSummary(
  scope: TenantScope,
  installationId: bigint,
  now: Date = new Date(),
): Promise<AzureSummary | null> {
  guard(scope, installationId);
  const c = await db.azureDevOpsConnection.findFirst({
    where: {
      installationId,
      installation: { deletedAt: null, suspendedAt: null },
    },
    select: {
      orgName: true,
      authKind: true,
      revokedAt: true,
      lastSyncStatus: true,
      lastSyncedAt: true,
      tokenExpiresAt: true,
      pausedUntil: true,
      managementEnabled: true,
      installation: { select: { rawRetentionDays: true } },
    },
  });
  if (!c) return null;
  const back = await db.azureDevOpsProject.findMany({
    where: {
      installationId,
      selected: true,
      removedAt: null,
      backfillDone: false,
      backfillBefore: { not: null },
    },
    select: { backfillBefore: true },
  });
  const cutoff = now.getTime() - c.installation.rawRetentionDays * DAY_MS;
  const left = back.length
    ? Math.max(
        ...back.map((b) =>
          Math.max(
            0,
            Math.ceil((b.backfillBefore!.getTime() - cutoff) / DAY_MS),
          ),
        ),
      )
    : null;
  return {
    connected: true,
    orgName: c.orgName,
    authKind: c.authKind,
    revoked: c.revokedAt != null,
    lastSyncStatus: c.lastSyncStatus,
    lastSyncedAt: iso(c.lastSyncedAt),
    tokenExpiresAt: iso(c.tokenExpiresAt),
    pausedUntil:
      c.pausedUntil && c.pausedUntil > now ? c.pausedUntil.toISOString() : null,
    managementEnabled: c.managementEnabled,
    backfilling: back.length,
    backfillDaysLeft: left,
  };
}

export type AzureScopesDto = Record<
  "projects" | "pools" | "builds" | "execute" | "hooks",
  string
>;

export type AzureSettings = {
  connection: null | {
    orgName: string;
    orgUrl: string;
    authKind: "PAT" | "ENV" | "ENTRA_SP";
    tokenHint: string | null;
    tokenExpiresAt: string | null;
    tenantId: string | null;
    clientId: string | null;
    scopes: AzureScopesDto;
    revokedAt: string | null;
    lastUsedAt: string | null;
    lastSyncStatus: string | null;
    lastSyncedAt: string | null;
    lastError: string | null;
    pausedUntil: string | null;
    definitionsSyncedAt: string | null;
    poolsSampledAt: string | null;
    usageSyncedAt: string | null;
    jobRequestsAvailable: boolean | null;
    managementEnabled: boolean;
    checkAppSlug: string;
    limits: {
      hostedParallelJobs: number;
      includedMinutes: number | null;
      maxJobMinutes: number;
      monthResetDay: number;
      blockWhenQuotaExhausted: boolean;
    };
    detected: {
      totalMinutes: number | null;
      totalCount: number | null;
      isPremium: boolean | null;
    } | null;
    hook: {
      configured: boolean;
      url: string | null;
      previousUntil: string | null;
      blockedUntil: string | null;
      subscriptions: Array<{ id: string; eventType: string; status: string }>;
    };
    createdAt: string;
  };
  /** The App receives check runs (checks: read and the check_run event). */
  hintsAvailable: boolean;
  rateLimit: { limit: number; remaining: number; resetAt: string } | null;
  projects: Array<{
    id: string;
    name: string;
    visibility: string;
    selected: boolean;
    backfillDone: boolean;
    cursor: string | null;
  }>;
  definitions: Array<{
    projectId: string;
    projectName: string;
    id: number;
    name: string;
    repoType: string;
    linkRepo: string | null;
    repositoryId: string | null;
    manualRepositoryId: string | null;
    osOverride: string | null;
  }>;
  repositories: Array<{ id: string; fullName: string }>;
};

/** Admin only (settings page): other roles get NotFoundError. */
export async function getAzureSettings(
  scope: TenantScope,
  installationId: bigint,
  hookUrlPrefix: string,
): Promise<AzureSettings> {
  guard(scope, installationId);
  if (!hasRole(scope.role, "ADMIN")) throw new NotFoundError();
  const inst = await activeInstallation(installationId);
  const [c, rate, projects, defs, repos, subs] = await Promise.all([
    db.azureDevOpsConnection.findUnique({ where: { installationId } }),
    db.installationRateLimit.findUnique({
      where: { installationId_resource: { installationId, resource: "azure" } },
    }),
    db.azureDevOpsProject.findMany({
      where: { installationId, removedAt: null },
      orderBy: { name: "asc" },
    }),
    db.azurePipelineDefinition.findMany({
      where: { installationId, removedAt: null },
      orderBy: [{ projectId: "asc" }, { name: "asc" }],
    }),
    db.repository.findMany({
      where: { installationId, removedAt: null, ignoredAt: null },
      orderBy: { fullName: "asc" },
      select: { id: true, fullName: true },
    }),
    db.azureHookSubscription.findMany({
      where: { installationId },
      orderBy: { eventType: "asc" },
    }),
  ]);
  const permissions = (inst.permissions ?? {}) as Record<string, unknown>;
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const scopes = (c?.scopes ?? {}) as Record<string, string>;
  const detected = (c?.detectedLimits ?? null) as {
    totalMinutes?: number | null;
    totalCount?: number | null;
    isPremium?: boolean | null;
  } | null;
  return {
    connection: c
      ? {
          orgName: c.orgName,
          orgUrl: azureOrgUrl(c.orgName),
          authKind: c.authKind,
          tokenHint: c.tokenHint,
          tokenExpiresAt: iso(c.tokenExpiresAt),
          tenantId: c.tenantId,
          clientId: c.clientId,
          scopes: {
            projects: scopes.projects ?? "unknown",
            pools: scopes.pools ?? "unknown",
            builds: scopes.builds ?? "unknown",
            execute: scopes.execute ?? "unknown",
            hooks: scopes.hooks ?? "unknown",
          },
          revokedAt: iso(c.revokedAt),
          lastUsedAt: iso(c.lastUsedAt),
          lastSyncStatus: c.lastSyncStatus,
          lastSyncedAt: iso(c.lastSyncedAt),
          lastError: c.lastError,
          pausedUntil: iso(c.pausedUntil),
          definitionsSyncedAt: iso(c.definitionsSyncedAt),
          poolsSampledAt: iso(c.poolsSampledAt),
          usageSyncedAt: iso(c.usageSyncedAt),
          jobRequestsAvailable: c.jobRequestsAvailable,
          managementEnabled: c.managementEnabled,
          checkAppSlug: c.checkAppSlug,
          limits: {
            hostedParallelJobs: c.hostedParallelJobs,
            includedMinutes: c.includedMinutes,
            maxJobMinutes: c.maxJobMinutes,
            monthResetDay: c.monthResetDay,
            blockWhenQuotaExhausted: c.blockWhenQuotaExhausted,
          },
          detected: detected
            ? {
                totalMinutes: detected.totalMinutes ?? null,
                totalCount: detected.totalCount ?? null,
                isPremium: detected.isPremium ?? null,
              }
            : null,
          hook: {
            configured: !!c.hookKey && !!c.hookSecret,
            url: c.hookKey ? `${hookUrlPrefix}${c.hookKey}` : null,
            previousUntil: iso(c.hookSecretPrevUntil),
            blockedUntil: iso(c.hookBlockedUntil),
            subscriptions: subs.map((s) => ({
              id: s.id,
              eventType: s.eventType,
              status: s.status,
            })),
          },
          createdAt: c.createdAt.toISOString(),
        }
      : null,
    hintsAvailable:
      missingOf("read.checks", permissions) === null &&
      inst.events.includes("check_run"),
    rateLimit: rate
      ? {
          limit: rate.limit,
          remaining: rate.remaining,
          resetAt: rate.resetAt.toISOString(),
        }
      : null,
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      visibility: p.visibility,
      selected: p.selected,
      backfillDone: p.backfillDone,
      cursor: iso(p.buildsCursor),
    })),
    definitions: defs.map((d) => ({
      projectId: d.projectId,
      projectName: projectName.get(d.projectId) ?? d.projectId,
      id: d.id,
      name: d.name,
      repoType: d.repoType,
      linkRepo: d.linkRepoFullName,
      repositoryId: d.repositoryId != null ? String(d.repositoryId) : null,
      manualRepositoryId:
        d.manualRepositoryId != null ? String(d.manualRepositoryId) : null,
      osOverride: d.osOverride,
    })),
    repositories: repos.map((r) => ({
      id: String(r.id),
      fullName: r.fullName,
    })),
  };
}

// ---------- local writes (run by src/server/management/azure*.ts) ----------

export type AzureConnectionWrite = {
  orgId: string;
  orgName: string;
  authKind: "PAT" | "ENTRA_SP";
  /** Ciphertext. */
  accessToken: string;
  tokenHint: string;
  tokenExpiresAt: Date | null;
  tenantId: string | null;
  clientId: string | null;
  scopes: Record<string, string>;
  userId: string;
};

export async function findAzureConnection(
  scope: TenantScope,
  installationId: bigint,
) {
  guard(scope, installationId);
  return db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: {
      orgId: true,
      orgName: true,
      authKind: true,
      tokenHint: true,
      tenantId: true,
      clientId: true,
      managementEnabled: true,
      scopes: true,
      hookKey: true,
      hookSecret: true,
      includedMinutes: true,
      hostedParallelJobs: true,
      maxJobMinutes: true,
      monthResetDay: true,
      blockWhenQuotaExhausted: true,
      detectedLimits: true,
    },
  });
}

/** True when the organisation is connected to another installation. */
export async function orgConnectedElsewhere(
  scope: TenantScope,
  installationId: bigint,
  orgId: string,
): Promise<boolean> {
  guard(scope, installationId);
  const row = await db.azureDevOpsConnection.findUnique({
    where: { orgId },
    select: { installationId: true },
  });
  return !!row && row.installationId !== installationId;
}

export async function createAzureConnection(
  scope: TenantScope,
  installationId: bigint,
  w: AzureConnectionWrite,
): Promise<"created" | "taken"> {
  guard(scope, installationId);
  try {
    await db.azureDevOpsConnection.create({
      data: {
        installationId,
        orgId: w.orgId,
        orgName: w.orgName,
        authKind: w.authKind,
        accessToken: w.accessToken,
        tokenHint: w.tokenHint,
        tokenExpiresAt: w.tokenExpiresAt,
        tenantId: w.tenantId,
        clientId: w.clientId,
        scopes: w.scopes,
        createdByUserId: w.userId,
      },
    });
    return "created";
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      return "taken";
    throw error;
  }
}

/** Rotate (or switch PAT ↔ service principal) for the same organisation. */
export async function rotateAzureConnection(
  scope: TenantScope,
  installationId: bigint,
  w: AzureConnectionWrite,
): Promise<boolean> {
  guard(scope, installationId);
  const { count } = await db.azureDevOpsConnection.updateMany({
    where: { installationId, orgId: w.orgId, authKind: { not: "ENV" } },
    data: {
      orgName: w.orgName,
      authKind: w.authKind,
      accessToken: w.accessToken,
      tokenHint: w.tokenHint,
      tokenExpiresAt: w.tokenExpiresAt,
      tenantId: w.tenantId,
      clientId: w.clientId,
      scopes: w.scopes,
      revokedAt: null,
      lastError: null,
      lastSyncStatus: null,
      pausedUntil: null,
    },
  });
  return count === 1;
}

/** Every table of the Azure DevOps data; the disconnect purges them all. */
export const AZURE_TABLES = [
  "AzureBuildJob",
  "AzureBuild",
  "AzurePipelineDefinition",
  "AzureDevOpsProject",
  "AzureAgent",
  "AzurePoolSample",
  "AzurePool",
  "AzureJobRequest",
  "DailyAzureUsage",
  "AzureUsageSnapshot",
  "AzureHookSubscription",
  "PipelineRollupDirty",
  "DailyPipelineStat",
  "AzureDevOpsConnection",
] as const;

/**
 * Disconnect (owner decision 4): deletes every Azure DevOps row of the
 * installation, its findings, its rate-limit row and its hook deliveries.
 * The audit rows stay.
 */
export async function deleteAzureConnection(
  scope: TenantScope,
  installationId: bigint,
): Promise<boolean> {
  guard(scope, installationId);
  return db.$transaction(
    async (tx) => {
      const exists = await tx.azureDevOpsConnection.findUnique({
        where: { installationId },
        select: { installationId: true },
      });
      for (const table of AZURE_TABLES)
        await tx.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "installationId" = $1::bigint`,
          installationId,
        );
      await tx.finding.deleteMany({
        where: {
          installationId,
          OR: [
            { source: "AZURE_PIPELINES" },
            { source: "CREDENTIAL", ruleKey: { startsWith: "azure:" } },
          ],
        },
      });
      await tx.installationRateLimit.deleteMany({
        where: { installationId, resource: "azure" },
      });
      await tx.webhookDelivery.deleteMany({
        where: { installationId, provider: "azure" },
      });
      return !!exists;
    },
    { timeout: 60_000 },
  );
}

export async function listAzureProjectsFor(
  scope: TenantScope,
  installationId: bigint,
) {
  guard(scope, installationId);
  return db.azureDevOpsProject.findMany({
    where: { installationId, removedAt: null },
    select: { id: true, name: true, selected: true },
  });
}

export async function setAzureProjectSelection(
  scope: TenantScope,
  installationId: bigint,
  selectedIds: ReadonlyArray<string>,
): Promise<void> {
  guard(scope, installationId);
  await db.$transaction([
    db.azureDevOpsProject.updateMany({
      where: {
        installationId,
        removedAt: null,
        id: { in: [...selectedIds] },
        selected: false,
      },
      // A newly selected project starts its history import.
      data: {
        selected: true,
        backfillDone: false,
        buildsCursor: null,
        buildsContinuation: null,
        buildsPassTop: null,
        backfillBefore: null,
      },
    }),
    db.azureDevOpsProject.updateMany({
      where: { installationId, id: { notIn: [...selectedIds] } },
      data: { selected: false },
    }),
    db.azureDevOpsConnection.updateMany({
      where: { installationId },
      data: { definitionsSyncedAt: null },
    }),
  ]);
}

export type DefinitionTarget = {
  projectId: string;
  id: number;
  name: string;
  manualRepositoryId: bigint | null;
  repositoryId: bigint | null;
  osOverride: string | null;
};

export async function findAzureDefinition(
  scope: TenantScope,
  installationId: bigint,
  projectId: string,
  definitionId: number,
): Promise<DefinitionTarget> {
  guard(scope, installationId);
  const d = await db.azurePipelineDefinition.findFirst({
    where: { installationId, projectId, id: definitionId, removedAt: null },
    select: {
      projectId: true,
      id: true,
      name: true,
      manualRepositoryId: true,
      repositoryId: true,
      osOverride: true,
    },
  });
  if (!d) throw new NotFoundError();
  return d;
}

export async function findLinkableRepo(
  scope: TenantScope,
  installationId: bigint,
  repositoryId: bigint,
): Promise<{ id: bigint; fullName: string; defaultBranch: string } | null> {
  guard(scope, installationId);
  return db.repository.findFirst({
    where: {
      id: repositoryId,
      installationId,
      removedAt: null,
      ignoredAt: null,
    },
    select: { id: true, fullName: true, defaultBranch: true },
  });
}

export async function setAzureDefinitionLink(
  scope: TenantScope,
  installationId: bigint,
  projectId: string,
  definitionId: number,
  repositoryId: bigint | null,
): Promise<void> {
  guard(scope, installationId);
  const { count } = await db.azurePipelineDefinition.updateMany({
    where: { installationId, projectId, id: definitionId },
    data: { manualRepositoryId: repositoryId },
  });
  if (count !== 1) throw new NotFoundError();
  // The builds of a newly linked definition are imported (backfill again).
  if (repositoryId != null)
    await db.azureDevOpsProject.updateMany({
      where: { installationId, id: projectId },
      data: { backfillDone: false, backfillBefore: new Date() },
    });
  await db.azureBuild.updateMany({
    where: { installationId, projectId, definitionId },
    data: { repositoryId },
  });
}

export async function setAzureDefinitionOs(
  scope: TenantScope,
  installationId: bigint,
  projectId: string,
  definitionId: number,
  os: "LINUX" | "WINDOWS" | "MACOS" | null,
): Promise<void> {
  guard(scope, installationId);
  const { count } = await db.azurePipelineDefinition.updateMany({
    where: { installationId, projectId, id: definitionId },
    data: { osOverride: os },
  });
  if (count !== 1) throw new NotFoundError();
  if (os)
    await db.$executeRaw`
      UPDATE "AzureBuildJob" j SET "os" = ${os}::"AzureOs"
      FROM "AzureBuild" b
      WHERE j."installationId" = ${installationId} AND b."installationId" = ${installationId}
        AND j."buildId" = b."id" AND b."projectId" = ${projectId} AND b."definitionId" = ${definitionId}
        AND j."type" = 'Job'`;
  // Recompute the stats of the definition's days.
  await db.$executeRaw`
    INSERT INTO "PipelineRollupDirty" ("installationId", "day", "markedAt")
    SELECT DISTINCT b."installationId", (b."queuedAt" AT TIME ZONE i."timezone")::date, now()
    FROM "AzureBuild" b JOIN "Installation" i ON i."id" = b."installationId"
    WHERE b."installationId" = ${installationId} AND b."projectId" = ${projectId} AND b."definitionId" = ${definitionId}
    ON CONFLICT ("installationId", "day") DO UPDATE SET "markedAt" = now()`;
}

export type AzureLimits = {
  hostedParallelJobs: number;
  includedMinutes: number | null;
  maxJobMinutes: number;
  monthResetDay: number;
  blockWhenQuotaExhausted: boolean;
};

export async function setAzureLimits(
  scope: TenantScope,
  installationId: bigint,
  limits: AzureLimits,
): Promise<void> {
  guard(scope, installationId);
  const { count } = await db.azureDevOpsConnection.updateMany({
    where: { installationId },
    data: limits,
  });
  if (count !== 1) throw new NotFoundError();
}

export async function setAzureHookCredentials(
  scope: TenantScope,
  installationId: bigint,
  w: {
    hookKey: string;
    hookSecret: string;
    hookSecretPrev: string | null;
    hookSecretPrevUntil: Date | null;
  },
): Promise<void> {
  guard(scope, installationId);
  const { count } = await db.azureDevOpsConnection.updateMany({
    where: { installationId },
    data: {
      ...w,
      hookFailures: 0,
      hookFailuresSince: null,
      hookBlockedUntil: null,
    },
  });
  if (count !== 1) throw new NotFoundError();
}

export async function setAzureHookSubscriptions(
  scope: TenantScope,
  installationId: bigint,
  subs: ReadonlyArray<{ id: string; eventType: string; projectId: string }>,
  scopeOk: boolean,
  now: Date,
): Promise<void> {
  guard(scope, installationId);
  for (const s of subs)
    await db.azureHookSubscription.upsert({
      where: { installationId_id: { installationId, id: s.id } },
      create: {
        installationId,
        id: s.id,
        eventType: s.eventType,
        projectId: s.projectId,
        status: "enabled",
        checkedAt: now,
      },
      update: {
        eventType: s.eventType,
        projectId: s.projectId,
        status: "enabled",
        checkedAt: now,
      },
    });
  await setAzureScope(
    scope,
    installationId,
    "hooks",
    scopeOk ? "ok" : "missing",
  );
}

export async function listAzureHookSubscriptions(
  scope: TenantScope,
  installationId: bigint,
) {
  guard(scope, installationId);
  return db.azureHookSubscription.findMany({
    where: { installationId },
    select: { id: true },
  });
}

export async function clearAzureHookSubscriptions(
  scope: TenantScope,
  installationId: bigint,
  ids: ReadonlyArray<string>,
): Promise<void> {
  guard(scope, installationId);
  await db.azureHookSubscription.deleteMany({
    where: { installationId, id: { in: [...ids] } },
  });
}

export async function setAzureScope(
  scope: TenantScope,
  installationId: bigint,
  key: "execute" | "hooks",
  value: "ok" | "missing",
): Promise<void> {
  guard(scope, installationId);
  const c = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: { scopes: true },
  });
  if (!c) throw new NotFoundError();
  const scopes = {
    ...((c.scopes ?? {}) as Record<string, unknown>),
    [key]: value,
  };
  await db.azureDevOpsConnection.updateMany({
    where: { installationId },
    data: { scopes: scopes as Prisma.InputJsonValue },
  });
}

export async function setAzureManagement(
  scope: TenantScope,
  installationId: bigint,
  enabled: boolean,
): Promise<void> {
  guard(scope, installationId);
  const { count } = await db.azureDevOpsConnection.updateMany({
    where: { installationId },
    data: { managementEnabled: enabled },
  });
  if (count !== 1) throw new NotFoundError();
}

/** A linked definition for the execute probe (the newest built one). */
export async function probeDefinition(
  scope: TenantScope,
  installationId: bigint,
): Promise<{
  projectId: string;
  id: number;
  defaultBranch: string | null;
} | null> {
  guard(scope, installationId);
  const d = await db.azurePipelineDefinition.findFirst({
    where: {
      installationId,
      removedAt: null,
      OR: [
        { repositoryId: { not: null } },
        { manualRepositoryId: { not: null } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: { projectId: true, id: true, defaultBranch: true },
  });
  return d;
}

// ---------- pipelines (definitions) ----------

export type PipelineRow = {
  projectId: string;
  projectName: string;
  id: number;
  name: string;
  yamlPath: string | null;
  /** The definition's default branch (prefills the queue dialog). */
  defaultBranch: string | null;
  repoFullName: string | null;
  linkRepo: string | null;
  link: "linked" | "manual" | "unlinked";
  os: string | null;
  lastStatus: string | null;
  lastResult: string | null;
  lastTimedOut: boolean;
  lastBuildId: number | null;
  lastAt: string | null;
  /** The latest completed default-branch run failed (or partially succeeded). */
  defaultFailing: boolean;
  summary: PipelineSummary;
  /** Job p90 in seconds over 7 days. */
  jobP90S: number | null;
  azureUrl: string;
};

export type PipelineFilter = "linked" | "unlinked" | "failing" | "macos";

const statSelect = {
  projectId: true,
  definitionId: true,
  builds: true,
  succeeded: true,
  partial: true,
  failed: true,
  canceled: true,
  timedOut: true,
  firstTrySuccess: true,
  flakyRecovered: true,
  durationHist: true,
  queueHist: true,
  jobSecondsHostedLinux: true,
  jobSecondsHostedWindows: true,
  jobSecondsHostedMacos: true,
  jobSecondsSelfHosted: true,
  jobsNearCap: true,
} satisfies Prisma.DailyPipelineStatSelect;

async function statsByDefinition(
  installationId: bigint,
  fromDay: string,
  toDay: string,
  extra: Prisma.DailyPipelineStatWhereInput = {},
) {
  const rows = await db.dailyPipelineStat.findMany({
    where: {
      installationId,
      day: {
        gte: new Date(`${fromDay}T00:00:00Z`),
        lte: new Date(`${toDay}T00:00:00Z`),
      },
      ...extra,
    },
    select: statSelect,
  });
  const by = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.projectId}:${r.definitionId}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return { rows, by };
}

/** Job p90 per definition over 7 days (seconds). */
async function jobP90(
  installationId: bigint,
  now: Date,
): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<
    Array<{ projectId: string; definitionId: number; p90: number | null }>
  >`
    SELECT b."projectId", b."definitionId",
           percentile_cont(0.9) WITHIN GROUP (ORDER BY j."durationS") AS p90
    FROM "AzureBuildJob" j
    JOIN "AzureBuild" b ON b."installationId" = j."installationId" AND b."id" = j."buildId"
    WHERE j."installationId" = ${installationId} AND j."type" = 'Job' AND j."durationS" IS NOT NULL
      AND j."startedAt" >= ${new Date(now.getTime() - 7 * DAY_MS)}
    GROUP BY 1, 2`;
  return new Map(
    rows
      .filter((r) => r.p90 != null)
      .map((r) => [`${r.projectId}:${r.definitionId}`, Number(r.p90)]),
  );
}

export type PipelinesPage = {
  rows: PipelineRow[];
  projects: Array<{ id: string; name: string }>;
  kpis: PipelineSummary & {
    definitions: number;
    linked: number;
    failing: number;
  };
};

export async function listPipelines(
  scope: TenantScope,
  installationId: bigint,
  query: {
    range: InsightRange;
    q?: string;
    filters: PipelineFilter[];
    projectId?: string;
    repositoryId?: bigint;
  },
  now: Date = new Date(),
): Promise<PipelinesPage> {
  guard(scope, installationId);
  const inst = await activeInstallation(installationId);
  const conn = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: { orgName: true },
  });
  if (!conn)
    return {
      rows: [],
      projects: [],
      kpis: { ...pipelineSummary([]), definitions: 0, linked: 0, failing: 0 },
    };
  const w = rangeWindow(query.range, now, inst.timezone);
  const projects = await db.azureDevOpsProject.findMany({
    where: { installationId, removedAt: null, selected: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const defs = await db.azurePipelineDefinition.findMany({
    where: {
      installationId,
      removedAt: null,
      projectId: query.projectId
        ? query.projectId
        : { in: projects.map((p) => p.id) },
      ...(query.repositoryId ? linkedTo(query.repositoryId) : {}),
      ...(query.q ? { name: { contains: query.q, mode: "insensitive" } } : {}),
    },
    orderBy: { name: "asc" },
  });
  const repos = await repoNames(installationId, defs.map(effectiveRepo));
  const { by } = await statsByDefinition(installationId, w.fromDay, w.toDay);
  const p90 = await jobP90(installationId, now);
  const latest = await db.$queryRaw<
    Array<{
      projectId: string;
      definitionId: number;
      id: number;
      status: string;
      result: string;
      timedOut: boolean;
      queuedAt: Date;
    }>
  >`
    SELECT DISTINCT ON ("projectId", "definitionId") "projectId", "definitionId", "id", "status"::text AS status,
           "result"::text AS result, "timedOut", "queuedAt"
    FROM "AzureBuild" WHERE "installationId" = ${installationId}
    ORDER BY "projectId", "definitionId", "queuedAt" DESC`;
  const last = new Map(
    latest.map((l) => [`${l.projectId}:${l.definitionId}`, l]),
  );
  // The latest completed default-branch run decides "failing" (as the finding does).
  const defaultRuns = await db.$queryRaw<
    Array<{
      projectId: string;
      definitionId: number;
      result: string;
      timedOut: boolean;
    }>
  >`
    SELECT DISTINCT ON ("projectId", "definitionId") "projectId", "definitionId",
           "result"::text AS result, "timedOut"
    FROM "AzureBuild"
    WHERE "installationId" = ${installationId} AND "status" = 'COMPLETED'
      AND "isDefaultBranch" AND "result" <> 'NONE'
    ORDER BY "projectId", "definitionId", "queuedAt" DESC`;
  const failingKeys = new Set(
    defaultRuns
      .filter(
        (r) =>
          r.result === "FAILED" ||
          r.result === "PARTIALLY_SUCCEEDED" ||
          r.timedOut,
      )
      .map((r) => `${r.projectId}:${r.definitionId}`),
  );
  let rows: PipelineRow[] = defs.map((d) => {
    const key = `${d.projectId}:${d.id}`;
    const rid = effectiveRepo(d);
    const repo = rid != null ? (repos.get(rid) ?? null) : null;
    const l = last.get(key);
    return {
      projectId: d.projectId,
      projectName: projectName.get(d.projectId) ?? d.projectId,
      id: d.id,
      name: d.name,
      yamlPath: d.yamlPath,
      defaultBranch: d.defaultBranch,
      repoFullName: repo,
      linkRepo: d.linkRepoFullName,
      link: repo
        ? d.manualRepositoryId != null
          ? "manual"
          : "linked"
        : "unlinked",
      os: d.osOverride,
      lastStatus: l?.status ?? null,
      lastResult: l?.result ?? null,
      lastTimedOut: l?.timedOut ?? false,
      lastBuildId: l?.id ?? null,
      lastAt: iso(l?.queuedAt),
      defaultFailing: failingKeys.has(key),
      summary: pipelineSummary(by.get(key) ?? []),
      jobP90S: p90.get(key) ?? null,
      azureUrl: azureDefinitionUrl(conn.orgName, d.projectId, d.id),
    };
  });
  const all = rows;
  if (query.filters.includes("linked"))
    rows = rows.filter((r) => r.link !== "unlinked");
  if (query.filters.includes("unlinked"))
    rows = rows.filter((r) => r.link === "unlinked");
  if (query.filters.includes("failing"))
    rows = rows.filter((r) => r.defaultFailing);
  if (query.filters.includes("macos"))
    rows = rows.filter(
      (r) => (r.summary.macosShare ?? 0) > 0 || r.os === "MACOS",
    );
  const linkedRows = all.filter((r) => r.link !== "unlinked");
  const summary = pipelineSummary(
    linkedRows.flatMap((r) => by.get(`${r.projectId}:${r.id}`) ?? []),
  );
  return {
    rows,
    projects,
    kpis: {
      ...summary,
      definitions: all.length,
      linked: linkedRows.length,
      failing: all.filter((r) => r.link !== "unlinked" && r.defaultFailing)
        .length,
    },
  };
}

// ---------- runs ----------

export type AzureRunRow = {
  id: number;
  projectId: string;
  definitionId: number;
  definitionName: string;
  buildNumber: string;
  repoFullName: string | null;
  headBranch: string | null;
  headSha: string | null;
  prNumber: number | null;
  reason: string;
  status: string;
  result: string;
  timedOut: boolean;
  maxAttempt: number;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  queueS: number | null;
  durationS: number | null;
  /** Hosted job minutes of the build (rounded up per job). */
  minutes: number | null;
  azureUrl: string;
  auditEntryId: string | null;
  auditLinkKind: string | null;
};

export type AzureRunFilter =
  "failed" | "running" | "queued" | "retried" | "default";

export type AzureRunQuery = {
  page: number;
  size: number;
  range: InsightRange;
  q?: string;
  filters: AzureRunFilter[];
  projectId?: string;
  definitionId?: number;
  repositoryId?: bigint;
};

const buildSelect = {
  id: true,
  projectId: true,
  definitionId: true,
  repositoryId: true,
  buildNumber: true,
  headBranch: true,
  headSha: true,
  prNumber: true,
  reason: true,
  status: true,
  result: true,
  timedOut: true,
  maxAttempt: true,
  queuedAt: true,
  startedAt: true,
  finishedAt: true,
  queueS: true,
  durationS: true,
  auditLogId: true,
  auditLinkKind: true,
} satisfies Prisma.AzureBuildSelect;

type BuildRecord = Prisma.AzureBuildGetPayload<{ select: typeof buildSelect }>;

async function definitionNames(
  installationId: bigint,
  rows: ReadonlyArray<{ projectId: string; definitionId: number }>,
) {
  const defs = await db.azurePipelineDefinition.findMany({
    where: {
      installationId,
      OR: [
        ...new Map(
          rows.map((r) => [`${r.projectId}:${r.definitionId}`, r]),
        ).values(),
      ].map((r) => ({
        projectId: r.projectId,
        id: r.definitionId,
      })),
    },
    select: { projectId: true, id: true, name: true },
  });
  return new Map(defs.map((d) => [`${d.projectId}:${d.id}`, d.name]));
}

async function minutesOf(
  installationId: bigint,
  ids: ReadonlyArray<number>,
): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<Array<{ buildId: number; minutes: number }>>`
    SELECT "buildId", COALESCE(sum(CEIL("durationS" / 60.0)), 0)::int AS minutes
    FROM "AzureBuildJob"
    WHERE "installationId" = ${installationId} AND "type" = 'Job' AND "isHosted" IS NOT FALSE
      AND "buildId" = ANY(${[...ids]}::int[])
    GROUP BY 1`;
  return new Map(rows.map((r) => [r.buildId, r.minutes]));
}

async function toRunRows(
  installationId: bigint,
  org: string,
  records: ReadonlyArray<BuildRecord>,
): Promise<AzureRunRow[]> {
  const [names, repos, minutes] = await Promise.all([
    definitionNames(installationId, records),
    repoNames(
      installationId,
      records.map((r) => r.repositoryId),
    ),
    minutesOf(
      installationId,
      records.map((r) => r.id),
    ),
  ]);
  return records.map((b) => ({
    id: b.id,
    projectId: b.projectId,
    definitionId: b.definitionId,
    definitionName:
      names.get(`${b.projectId}:${b.definitionId}`) ?? `#${b.definitionId}`,
    buildNumber: b.buildNumber,
    repoFullName:
      b.repositoryId != null ? (repos.get(b.repositoryId) ?? null) : null,
    headBranch: b.headBranch,
    headSha: b.headSha,
    prNumber: b.prNumber,
    reason: b.reason,
    status: b.status,
    result: b.result,
    timedOut: b.timedOut,
    maxAttempt: b.maxAttempt,
    queuedAt: b.queuedAt.toISOString(),
    startedAt: iso(b.startedAt),
    finishedAt: iso(b.finishedAt),
    queueS: b.queueS,
    durationS: b.durationS,
    minutes: minutes.get(b.id) ?? null,
    azureUrl: azureBuildUrl(org, b.projectId, b.id),
    auditEntryId: b.auditLogId,
    auditLinkKind: b.auditLogId ? b.auditLinkKind : null,
  }));
}

export async function listAzureRuns(
  scope: TenantScope,
  installationId: bigint,
  query: AzureRunQuery,
  now: Date = new Date(),
): Promise<
  Page<AzureRunRow> & {
    definitions: Array<{ projectId: string; id: number; name: string }>;
    open: number;
  }
> {
  guard(scope, installationId);
  const inst = await activeInstallation(installationId);
  const conn = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: { orgName: true },
  });
  if (!conn)
    return {
      rows: [],
      total: 0,
      page: 1,
      size: query.size,
      definitions: [],
      open: 0,
    };
  const { from } = rangeWindow(query.range, now, inst.timezone);
  const and: Prisma.AzureBuildWhereInput[] = [];
  if (query.filters.includes("failed"))
    and.push({
      OR: [
        { result: { in: ["FAILED", "PARTIALLY_SUCCEEDED"] } },
        { timedOut: true },
      ],
    });
  if (query.filters.includes("running"))
    and.push({ status: { in: ["IN_PROGRESS", "CANCELLING"] } });
  if (query.filters.includes("queued"))
    and.push({ status: { in: ["NOT_STARTED", "POSTPONED"] } });
  if (query.filters.includes("retried")) and.push({ maxAttempt: { gt: 1 } });
  if (query.filters.includes("default")) and.push({ isDefaultBranch: true });
  const q = query.q?.trim();
  if (q)
    and.push({
      OR: [
        { headBranch: { contains: q, mode: "insensitive" } },
        { headSha: { startsWith: q.toLowerCase() } },
        { buildNumber: { contains: q } },
      ],
    });
  const where: Prisma.AzureBuildWhereInput = {
    installationId,
    queuedAt: { gte: from },
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.definitionId ? { definitionId: query.definitionId } : {}),
    ...(query.repositoryId ? { repositoryId: query.repositoryId } : {}),
    ...(and.length ? { AND: and } : {}),
  };
  const total = await db.azureBuild.count({ where });
  const pages = Math.max(1, Math.ceil(total / query.size));
  const page = Math.min(Math.max(1, query.page), pages);
  const [records, defs, open] = await Promise.all([
    db.azureBuild.findMany({
      where,
      orderBy: [{ queuedAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * query.size,
      take: query.size,
      select: buildSelect,
    }),
    db.azurePipelineDefinition.findMany({
      where: {
        installationId,
        removedAt: null,
        OR: [
          { repositoryId: { not: null } },
          { manualRepositoryId: { not: null } },
        ],
      },
      orderBy: { name: "asc" },
      select: { projectId: true, id: true, name: true },
    }),
    db.azureBuild.count({
      where: { installationId, status: { not: "COMPLETED" } },
    }),
  ]);
  return {
    rows: await toRunRows(installationId, conn.orgName, records),
    total,
    page,
    size: query.size,
    definitions: defs,
    open,
  };
}

export type AzureJobDto = {
  recordId: string;
  attempt: number;
  type: string;
  identifier: string | null;
  stageIdentifier: string | null;
  name: string;
  state: string;
  result: string;
  os: string;
  isHosted: boolean | null;
  hostedImage: string | null;
  workerName: string | null;
  hasLog: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  durationS: number | null;
  queueS: number | null;
  hitJobCap: boolean;
};

export type AzureRunDetail = {
  run: AzureRunRow;
  defaultBranch: string | null;
  /** The definition's p90 of the last 30 days in minutes (action dialogs). */
  p90Minutes: number | null;
  stages: Array<AzureJobDto & { jobs: AzureJobDto[] }>;
  /** Jobs without a known stage. */
  jobs: AzureJobDto[];
  maxJobMinutes: number;
  orgName: string;
  /** Lowercase full name for GitHub links. */
  repoFullName: string | null;
};

export async function getAzureRun(
  scope: TenantScope,
  installationId: bigint,
  buildId: number,
): Promise<AzureRunDetail> {
  guard(scope, installationId);
  await activeInstallation(installationId);
  const conn = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: { orgName: true, maxJobMinutes: true },
  });
  if (!conn) throw new NotFoundError();
  const b = await db.azureBuild.findFirst({
    where: { installationId, id: buildId },
    select: buildSelect,
  });
  if (!b) throw new NotFoundError();
  // A build of an ignored or removed repository is not shown.
  if (b.repositoryId != null) {
    const repo = await db.repository.findFirst({
      where: { id: b.repositoryId, installationId },
      select: { ignoredAt: true },
    });
    if (repo?.ignoredAt) throw new NotFoundError();
  }
  const [run] = await toRunRows(installationId, conn.orgName, [b]);
  const def = await db.azurePipelineDefinition.findFirst({
    where: { installationId, projectId: b.projectId, id: b.definitionId },
    select: { defaultBranch: true },
  });
  const records = await db.azureBuildJob.findMany({
    where: { installationId, buildId },
    orderBy: [
      { startedAt: { sort: "asc", nulls: "last" } },
      { attempt: "asc" },
    ],
  });
  const dto = (r: (typeof records)[number]): AzureJobDto => ({
    recordId: r.recordId,
    attempt: r.attempt,
    type: r.type,
    identifier: r.identifier,
    stageIdentifier: r.stageIdentifier,
    name: r.name,
    state: r.state,
    result: r.result,
    os: r.os,
    isHosted: r.isHosted,
    hostedImage: r.hostedImage,
    workerName: r.workerName,
    hasLog: r.logId != null,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    durationS: r.durationS,
    queueS: r.queueS,
    hitJobCap: r.hitJobCap,
  });
  // The latest attempt of each stage, with its jobs (every attempt).
  const stageRows = records.filter((r) => r.type === "Stage");
  const latestStage = new Map<string, (typeof records)[number]>();
  for (const s of stageRows) {
    const key = s.identifier ?? s.recordId;
    const prev = latestStage.get(key);
    if (!prev || s.attempt > prev.attempt) latestStage.set(key, s);
  }
  const jobs = records.filter((r) => r.type === "Job");
  const stages = [...latestStage.values()].map((s) => ({
    ...dto(s),
    jobs: jobs
      .filter((j) => j.stageIdentifier && j.stageIdentifier === s.identifier)
      .map(dto),
  }));
  const placed = new Set(
    stages.flatMap((s) => s.jobs.map((j) => `${j.recordId}:${j.attempt}`)),
  );
  return {
    run: run!,
    defaultBranch: def?.defaultBranch ?? null,
    p90Minutes: await definitionP90Minutes(
      installationId,
      b.projectId,
      b.definitionId,
      new Date(),
    ),
    stages,
    jobs: jobs
      .filter((j) => !placed.has(`${j.recordId}:${j.attempt}`))
      .map(dto),
    maxJobMinutes: conn.maxJobMinutes,
    orgName: conn.orgName,
    repoFullName: run!.repoFullName,
  };
}

// ---------- M7b: action state and targets ----------

export type AzureActionState = {
  canAct: boolean;
  blockedBy:
    | null
    | "role"
    | "management_disabled_global"
    | "azure_management_disabled_global"
    | "management_disabled_installation"
    | "azure_management_disabled"
    | "azure_revoked"
    | "azure_scope_missing"
    | "azure_rate_limited";
  canViewLog: boolean;
  orgName: string;
  /** Minutes left of the included minutes (null: paid tier). */
  minutesLeft: number | null;
  maxJobMinutes: number;
  hostedParallelJobs: number;
  /** Builds running now (hosted parallel slots in use). */
  running: number;
  queued: number;
  blockWhenQuotaExhausted: boolean;
};

export async function getAzureActionState(
  scope: TenantScope,
  installationId: bigint,
  managementGlobal: boolean,
  azureGlobal: boolean,
  now: Date = new Date(),
): Promise<AzureActionState | null> {
  guard(scope, installationId);
  const inst = await activeInstallation(installationId);
  const c = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: {
      orgName: true,
      revokedAt: true,
      pausedUntil: true,
      managementEnabled: true,
      scopes: true,
      includedMinutes: true,
      maxJobMinutes: true,
      hostedParallelJobs: true,
      monthResetDay: true,
      blockWhenQuotaExhausted: true,
    },
  });
  if (!c) return null;
  const operator = hasRole(scope.role, "OPERATOR");
  const execute =
    ((c.scopes ?? {}) as Record<string, unknown>).execute === "ok";
  const blockedBy: AzureActionState["blockedBy"] = !operator
    ? "role"
    : c.revokedAt
      ? "azure_revoked"
      : !managementGlobal
        ? "management_disabled_global"
        : !azureGlobal
          ? "azure_management_disabled_global"
          : !inst.managementEnabled
            ? "management_disabled_installation"
            : c.pausedUntil && c.pausedUntil > now
              ? "azure_rate_limited"
              : !c.managementEnabled
                ? "azure_management_disabled"
                : !execute
                  ? "azure_scope_missing"
                  : null;
  const usage = await getMinutesUsed(
    installationId,
    inst.timezone,
    c.monthResetDay,
    now,
  );
  const [running, queued] = await Promise.all([
    db.azureBuild.count({
      where: { installationId, status: { in: ["IN_PROGRESS", "CANCELLING"] } },
    }),
    db.azureBuild.count({
      where: { installationId, status: { in: ["NOT_STARTED", "POSTPONED"] } },
    }),
  ]);
  return {
    canAct: blockedBy === null,
    blockedBy,
    canViewLog: operator && !c.revokedAt,
    orgName: c.orgName,
    minutesLeft:
      c.includedMinutes == null
        ? null
        : Math.max(0, c.includedMinutes - usage.used),
    maxJobMinutes: c.maxJobMinutes,
    hostedParallelJobs: c.hostedParallelJobs,
    running,
    queued,
    blockWhenQuotaExhausted: c.blockWhenQuotaExhausted,
  };
}

async function getMinutesUsed(
  installationId: bigint,
  timezone: string,
  resetDay: number,
  now: Date,
) {
  const month = billingMonth(localDay(now, timezone), resetDay);
  const [api, est] = await Promise.all([
    db.azureUsageSnapshot.findUnique({
      where: {
        installationId_month_source: {
          installationId,
          month: month.key,
          source: "api",
        },
      },
      select: { usedMinutes: true, capturedAt: true },
    }),
    db.dailyAzureUsage.aggregate({
      where: {
        installationId,
        day: {
          gte: new Date(`${month.startDay}T00:00:00Z`),
          lt: new Date(`${month.endDay}T00:00:00Z`),
        },
      },
      _sum: {
        hostedMinutesPrivate: true,
        hostedMinutesPublic: true,
        hostedMinutesMacos: true,
      },
    }),
  ]);
  const estimate = est._sum.hostedMinutesPrivate ?? 0;
  const note = usageNote(api?.usedMinutes ?? null, estimate);
  return {
    month,
    used: note.shown ?? 0,
    api: api?.usedMinutes ?? null,
    apiAt: iso(api?.capturedAt),
    estimate,
    differs: note.differs,
    source: note.source,
    publicMinutes: est._sum.hostedMinutesPublic ?? 0,
    macosMinutes: est._sum.hostedMinutesMacos ?? 0,
  };
}

export type AzureBuildTarget = {
  id: number;
  projectId: string;
  definitionId: number;
  status: string;
  result: string;
  headBranch: string | null;
  repositoryId: bigint | null;
  repoFullName: string | null;
  definitionName: string;
  orgName: string;
  timezone: string;
  actingAs: string;
  stages: Array<{ identifier: string; state: string; result: string }>;
  logs: Array<{ recordId: string; attempt: number; logId: number }>;
};

/** The build an M7b action targets (NotFoundError outside the scope or for another installation). */
export async function findAzureBuildTarget(
  scope: TenantScope,
  installationId: bigint,
  buildId: number,
): Promise<AzureBuildTarget> {
  guard(scope, installationId);
  const inst = await activeInstallation(installationId);
  const [b, conn] = await Promise.all([
    db.azureBuild.findFirst({
      where: { installationId, id: buildId },
      select: {
        id: true,
        projectId: true,
        definitionId: true,
        status: true,
        result: true,
        headBranch: true,
        repositoryId: true,
      },
    }),
    db.azureDevOpsConnection.findUnique({
      where: { installationId },
      select: { orgName: true, authKind: true, tokenHint: true },
    }),
  ]);
  if (!b || !conn) throw new NotFoundError();
  const [def, repo, records] = await Promise.all([
    db.azurePipelineDefinition.findFirst({
      where: { installationId, projectId: b.projectId, id: b.definitionId },
      select: { name: true },
    }),
    b.repositoryId != null
      ? db.repository.findFirst({
          where: {
            id: b.repositoryId,
            installationId,
            removedAt: null,
            ignoredAt: null,
          },
          select: { id: true, fullName: true },
        })
      : Promise.resolve(null),
    db.azureBuildJob.findMany({
      where: { installationId, buildId },
      select: {
        recordId: true,
        attempt: true,
        type: true,
        identifier: true,
        state: true,
        result: true,
        logId: true,
      },
    }),
  ]);
  const latestStage = new Map<string, (typeof records)[number]>();
  for (const r of records.filter((x) => x.type === "Stage" && x.identifier)) {
    const prev = latestStage.get(r.identifier!);
    if (!prev || r.attempt > prev.attempt) latestStage.set(r.identifier!, r);
  }
  return {
    id: b.id,
    projectId: b.projectId,
    definitionId: b.definitionId,
    status: b.status,
    result: b.result,
    headBranch: b.headBranch,
    repositoryId: repo?.id ?? null,
    repoFullName: repo?.fullName ?? null,
    definitionName: def?.name ?? `#${b.definitionId}`,
    orgName: conn.orgName,
    timezone: inst.timezone,
    actingAs:
      conn.authKind === "ENV"
        ? "azure:env-token"
        : `azure:${conn.authKind === "PAT" ? "pat" : "sp"}:${conn.tokenHint ?? "unknown"}`,
    stages: [...latestStage.values()].map((s) => ({
      identifier: s.identifier!,
      state: s.state,
      result: s.result,
    })),
    logs: records
      .filter((r) => r.type === "Job" && r.logId != null)
      .map((r) => ({
        recordId: r.recordId,
        attempt: r.attempt,
        logId: r.logId!,
      })),
  };
}

export type AzureDefinitionTarget = {
  projectId: string;
  id: number;
  name: string;
  repositoryId: bigint | null;
  repoFullName: string | null;
  defaultBranch: string | null;
  orgName: string;
  actingAs: string;
  timezone: string;
  /** Job p90 of the definition over 7 days (minutes). */
  p90Minutes: number | null;
};

export async function findAzureDefinitionTarget(
  scope: TenantScope,
  installationId: bigint,
  projectId: string,
  definitionId: number,
  now: Date = new Date(),
): Promise<AzureDefinitionTarget> {
  guard(scope, installationId);
  const inst = await activeInstallation(installationId);
  const [d, conn] = await Promise.all([
    db.azurePipelineDefinition.findFirst({
      where: { installationId, projectId, id: definitionId, removedAt: null },
      select: {
        projectId: true,
        id: true,
        name: true,
        repositoryId: true,
        manualRepositoryId: true,
        defaultBranch: true,
      },
    }),
    db.azureDevOpsConnection.findUnique({
      where: { installationId },
      select: { orgName: true, authKind: true, tokenHint: true },
    }),
  ]);
  if (!d || !conn) throw new NotFoundError();
  const rid = effectiveRepo(d);
  const repo =
    rid != null
      ? await db.repository.findFirst({
          where: { id: rid, installationId, removedAt: null, ignoredAt: null },
          select: { id: true, fullName: true, defaultBranch: true },
        })
      : null;
  const p90Minutes = await definitionP90Minutes(
    installationId,
    projectId,
    definitionId,
    now,
  );
  return {
    projectId: d.projectId,
    id: d.id,
    name: d.name,
    repositoryId: repo?.id ?? null,
    repoFullName: repo?.fullName ?? null,
    defaultBranch: d.defaultBranch ?? repo?.defaultBranch ?? null,
    orgName: conn.orgName,
    timezone: inst.timezone,
    actingAs:
      conn.authKind === "ENV"
        ? "azure:env-token"
        : `azure:${conn.authKind === "PAT" ? "pat" : "sp"}:${conn.tokenHint ?? "unknown"}`,
    p90Minutes,
  };
}

/** A definition's p90 build duration of the last 30 days, in minutes (dialogs, quota). */
async function definitionP90Minutes(
  installationId: bigint,
  projectId: string,
  definitionId: number,
  now: Date,
): Promise<number | null> {
  const durations = await db.$queryRaw<Array<{ d: number }>>`
    SELECT b."durationS" AS d FROM "AzureBuild" b
    WHERE b."installationId" = ${installationId} AND b."projectId" = ${projectId}
      AND b."definitionId" = ${definitionId} AND b."durationS" IS NOT NULL
      AND b."queuedAt" >= ${new Date(now.getTime() - 30 * DAY_MS)}`;
  const p90 = percentileExact(
    durations.map((x) => x.d),
    0.9,
  );
  return p90 == null ? null : Math.round(p90 / 60);
}

/** Branches known for a repository (stored runs and builds, plus the default). */
export async function knownBranch(
  scope: TenantScope,
  installationId: bigint,
  repositoryId: bigint,
  branch: string,
): Promise<boolean> {
  guard(scope, installationId);
  const repo = await db.repository.findFirst({
    where: { id: repositoryId, installationId },
    select: { defaultBranch: true },
  });
  if (!repo) return false;
  if (repo.defaultBranch === branch) return true;
  const [run, build] = await Promise.all([
    db.workflowRun.findFirst({
      where: { installationId, repositoryId, headBranch: branch },
      select: { id: true },
    }),
    db.azureBuild.findFirst({
      where: { installationId, repositoryId, headBranch: branch },
      select: { id: true },
    }),
  ]);
  return !!run || !!build;
}

/** After an action: the re-read build is stored, its days marked dirty. */
export async function markAzureBuildDirty(
  scope: TenantScope,
  installationId: bigint,
  buildId: number,
): Promise<void> {
  guard(scope, installationId);
  await db.azureBuild.updateMany({
    where: { installationId, id: buildId },
    data: { dirtyAt: new Date() },
  });
}

export async function linkAzureBuildAudit(
  scope: TenantScope,
  installationId: bigint,
  buildId: number,
  auditId: string,
): Promise<void> {
  guard(scope, installationId);
  await db.azureBuild.updateMany({
    where: { installationId, id: buildId },
    data: { auditLogId: auditId, auditLinkKind: "exact" },
  });
}

// ---------- usage ----------

export type AzureUsage = {
  orgName: string;
  paid: boolean;
  included: number | null;
  used: number;
  source: "api" | "estimate" | null;
  api: number | null;
  apiAt: string | null;
  estimate: number;
  differs: boolean;
  projected: number;
  limitDay: string | null;
  level: QuotaLevel;
  month: {
    startDay: string;
    endDay: string;
    daysLeft: number;
    resetDay: number;
  };
  publicMinutes: number;
  osSplit: { macos: number; linux: number; windows: number };
  perDay: Array<{
    day: string;
    macos: number;
    linux: number;
    windows: number;
    public: number;
  }>;
  parallel: {
    limit: number;
    running: number;
    queued: number;
    at: string | null;
    /** The last 24 h of hosted samples. */
    samples: Array<{ at: string; running: number; queued: number }>;
  };
  saturation: {
    share7d: number | null;
    queueMinutesWeek: number;
    jobsOver10m: number;
  };
  maxJobMinutes: number;
  nearCap: Array<{
    projectId: string;
    definitionId: number;
    name: string;
    p90Minutes: number;
    hits: number;
  }>;
  pools: Array<{
    id: number;
    name: string;
    isHosted: boolean;
    size: number | null;
    online: number | null;
    running: number;
    queued: number;
    agents: Array<{
      id: number;
      name: string;
      status: string;
      enabled: boolean;
      busy: boolean;
      version: string | null;
      osDescription: string | null;
    }>;
  }>;
  detected: {
    totalMinutes: number | null;
    totalCount: number | null;
    isPremium: boolean | null;
  } | null;
  /** The usage figures are partial (estimated from synced builds). */
  partial: boolean;
};

export async function getAzureUsage(
  scope: TenantScope,
  installationId: bigint,
  now: Date = new Date(),
): Promise<AzureUsage | null> {
  guard(scope, installationId);
  const inst = await activeInstallation(installationId);
  const c = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: {
      orgName: true,
      includedMinutes: true,
      hostedParallelJobs: true,
      maxJobMinutes: true,
      monthResetDay: true,
      detectedLimits: true,
      jobRequestsAvailable: true,
    },
  });
  if (!c) return null;
  const u = await getMinutesUsed(
    installationId,
    inst.timezone,
    c.monthResetDay,
    now,
  );
  const projected = projectWindow(u.used, u.month);
  const perDayRows = await db.dailyAzureUsage.findMany({
    where: {
      installationId,
      day: {
        gte: new Date(`${u.month.startDay}T00:00:00Z`),
        lt: new Date(`${u.month.endDay}T00:00:00Z`),
      },
    },
    orderBy: { day: "asc" },
  });
  const week = await db.dailyAzureUsage.aggregate({
    where: {
      installationId,
      day: { gte: new Date(now.getTime() - 7 * DAY_MS) },
    },
    _sum: { saturatedS: true, saturationQueueS: true, jobsQueuedOver10m: true },
    _count: { day: true },
  });
  const pools = await db.azurePool.findMany({
    where: { installationId, removedAt: null },
    orderBy: [{ isHosted: "desc" }, { name: "asc" }],
  });
  const agents = await db.azureAgent.findMany({
    where: { installationId },
    orderBy: { name: "asc" },
  });
  const latestSamples = await Promise.all(
    pools.map((p) =>
      db.azurePoolSample.findFirst({
        where: { installationId, poolId: p.id },
        orderBy: { at: "desc" },
      }),
    ),
  );
  const hostedIds = pools.filter((p) => p.isHosted).map((p) => p.id);
  const samples = await db.azurePoolSample.findMany({
    where: {
      installationId,
      poolId: { in: hostedIds },
      at: { gte: new Date(now.getTime() - DAY_MS) },
    },
    orderBy: { at: "asc" },
    select: { at: true, running: true, queued: true },
  });
  const hostedLatest = latestSamples.filter((s, i) => s && pools[i]!.isHosted);
  const latestHosted =
    hostedLatest.sort((a, b) => b!.at.getTime() - a!.at.getTime())[0] ?? null;
  const caps = await db.$queryRaw<
    Array<{
      projectId: string;
      definitionId: number;
      p90: number | null;
      hits: number;
    }>
  >`
    SELECT b."projectId", b."definitionId",
           percentile_cont(0.9) WITHIN GROUP (ORDER BY j."durationS") AS p90,
           count(*) FILTER (WHERE j."hitJobCap")::int AS hits
    FROM "AzureBuildJob" j
    JOIN "AzureBuild" b ON b."installationId" = j."installationId" AND b."id" = j."buildId"
    WHERE j."installationId" = ${installationId} AND j."type" = 'Job' AND j."durationS" IS NOT NULL
      AND j."startedAt" >= ${new Date(now.getTime() - 7 * DAY_MS)}
    GROUP BY 1, 2`;
  const capRows = caps.filter(
    (r) => (r.p90 ?? 0) / 60 >= c.maxJobMinutes - 10 || r.hits > 0,
  );
  const names = await definitionNames(installationId, capRows);
  const detected = (c.detectedLimits ?? null) as {
    totalMinutes?: number | null;
    totalCount?: number | null;
    isPremium?: boolean | null;
  } | null;
  const days = week._count.day || 0;
  const paid = c.includedMinutes == null || detected?.isPremium === true;
  return {
    orgName: c.orgName,
    paid,
    included: c.includedMinutes,
    used: u.used,
    source: u.source,
    api: u.api,
    apiAt: u.apiAt,
    estimate: u.estimate,
    differs: u.differs,
    projected: Math.round(projected),
    limitDay:
      c.includedMinutes != null
        ? limitDay(u.used, c.includedMinutes, u.month)
        : null,
    level: quotaLevel(
      u.used,
      paid ? null : c.includedMinutes,
      projected,
      u.month.daysLeft,
    ),
    month: {
      startDay: u.month.startDay,
      endDay: u.month.endDay,
      daysLeft: u.month.daysLeft,
      resetDay: c.monthResetDay,
    },
    publicMinutes: u.publicMinutes,
    osSplit: {
      macos: perDayRows.reduce((s, r) => s + r.hostedMinutesMacos, 0),
      linux: perDayRows.reduce((s, r) => s + r.hostedMinutesLinux, 0),
      windows: perDayRows.reduce((s, r) => s + r.hostedMinutesWindows, 0),
    },
    perDay: perDayRows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      macos: r.hostedMinutesMacos,
      linux: r.hostedMinutesLinux,
      windows: r.hostedMinutesWindows,
      public: r.hostedMinutesPublic,
    })),
    parallel: {
      limit: c.hostedParallelJobs,
      running: latestHosted?.running ?? 0,
      queued: latestHosted?.queued ?? 0,
      at: iso(latestHosted?.at),
      samples: samples.map((s) => ({
        at: s.at.toISOString(),
        running: s.running,
        queued: s.queued,
      })),
    },
    saturation: {
      share7d: days > 0 ? (week._sum.saturatedS ?? 0) / (days * 86_400) : null,
      queueMinutesWeek: Math.round((week._sum.saturationQueueS ?? 0) / 60),
      jobsOver10m: week._sum.jobsQueuedOver10m ?? 0,
    },
    maxJobMinutes: c.maxJobMinutes,
    nearCap: capRows.map((r) => ({
      projectId: r.projectId,
      definitionId: r.definitionId,
      name:
        names.get(`${r.projectId}:${r.definitionId}`) ?? `#${r.definitionId}`,
      p90Minutes: Math.round((r.p90 ?? 0) / 60),
      hits: r.hits,
    })),
    pools: pools.map((p, i) => ({
      id: p.id,
      name: p.name,
      isHosted: p.isHosted,
      size: p.size,
      online: latestSamples[i]?.onlineAgents ?? null,
      running: latestSamples[i]?.running ?? 0,
      queued: latestSamples[i]?.queued ?? 0,
      agents: agents
        .filter((a) => a.poolId === p.id)
        .map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          enabled: a.enabled,
          busy: a.busy,
          version: a.version,
          osDescription: a.osDescription,
        })),
    })),
    detected: detected
      ? {
          totalMinutes: detected.totalMinutes ?? null,
          totalCount: detected.totalCount ?? null,
          isPremium: detected.isPremium ?? null,
        }
      : null,
    partial: c.jobRequestsAvailable === false,
  };
}

// ---------- overview, repository, pull requests, queue, runners, costs ----------

export type AzureCard = {
  orgName: string;
  revoked: boolean;
  usage: Pick<
    AzureUsage,
    | "paid"
    | "included"
    | "used"
    | "source"
    | "projected"
    | "limitDay"
    | "level"
    | "parallel"
    | "differs"
    | "estimate"
    | "api"
  >;
  failing: number;
  openFindings: number;
};

export async function getAzureCard(
  scope: TenantScope,
  installationId: bigint,
  now: Date = new Date(),
): Promise<AzureCard | null> {
  const usage = await getAzureUsage(scope, installationId, now);
  if (!usage) return null;
  const [conn, failing, findings] = await Promise.all([
    db.azureDevOpsConnection.findUnique({
      where: { installationId },
      select: { revokedAt: true },
    }),
    db.finding.count({
      where: {
        installationId,
        source: "AZURE_PIPELINES",
        status: "OPEN",
        ruleKey: { startsWith: "azure:default-failing:" },
      },
    }),
    db.finding.count({
      where: {
        installationId,
        status: "OPEN",
        OR: [
          { source: "AZURE_PIPELINES" },
          { source: "CREDENTIAL", ruleKey: { startsWith: "azure:" } },
        ],
      },
    }),
  ]);
  return {
    orgName: usage.orgName,
    revoked: conn?.revokedAt != null,
    usage,
    failing,
    openFindings: findings,
  };
}

export type RepoPipeline = PipelineRow;

/** The repository's Pipelines tab: its linked definitions with their KPIs. */
export async function getRepoPipelines(
  scope: TenantScope,
  installationId: bigint,
  repositoryId: bigint,
  range: InsightRange,
  now: Date = new Date(),
): Promise<PipelineRow[]> {
  guard(scope, installationId);
  const repo = await db.repository.findFirst({
    where: {
      id: repositoryId,
      installationId,
      removedAt: null,
      ignoredAt: null,
    },
    select: { id: true },
  });
  if (!repo) throw new NotFoundError();
  const page = await listPipelines(
    scope,
    installationId,
    { range, filters: [], repositoryId },
    now,
  );
  return page.rows;
}

export type PrBuild = {
  id: number;
  definitionName: string;
  status: string;
  result: string;
  timedOut: boolean;
  href: string;
};

/**
 * Azure Pipelines builds of pull requests: by head SHA, and through the
 * PR number (secondary join, PR builds of a merge commit). Keys are
 * "<repositoryId>:<number>"; the newest build per definition.
 */
export async function azureBuildsForPulls(
  scope: TenantScope,
  installationId: bigint,
  pulls: ReadonlyArray<{
    repositoryId: string;
    number: number;
    headSha: string;
  }>,
  hrefOf: (buildId: number) => string,
): Promise<Record<string, PrBuild[]>> {
  guard(scope, installationId);
  if (pulls.length === 0) return {};
  const conn = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: { installationId: true },
  });
  if (!conn) return {};
  const shas = [
    ...new Set(
      pulls
        .map((p) => p.headSha.toLowerCase())
        .filter((s) => /^[0-9a-f]{40}$/.test(s)),
    ),
  ];
  const repoIds = [...new Set(pulls.map((p) => BigInt(p.repositoryId)))];
  const rows = await db.azureBuild.findMany({
    where: {
      installationId,
      repositoryId: { in: repoIds },
      OR: [
        { headSha: { in: shas } },
        { prNumber: { in: [...new Set(pulls.map((p) => p.number))] } },
      ],
    },
    orderBy: { queuedAt: "desc" },
    take: 1000,
    select: {
      id: true,
      projectId: true,
      definitionId: true,
      repositoryId: true,
      headSha: true,
      prNumber: true,
      status: true,
      result: true,
      timedOut: true,
    },
  });
  const names = await definitionNames(installationId, rows);
  const out: Record<string, PrBuild[]> = {};
  for (const p of pulls) {
    const key = `${p.repositoryId}:${p.number}`;
    const seen = new Set<string>();
    const list: PrBuild[] = [];
    for (const b of rows) {
      if (String(b.repositoryId) !== p.repositoryId) continue;
      if (b.headSha !== p.headSha.toLowerCase() && b.prNumber !== p.number)
        continue;
      const d = `${b.projectId}:${b.definitionId}`;
      if (seen.has(d)) continue;
      seen.add(d);
      list.push({
        id: b.id,
        definitionName: names.get(d) ?? `#${b.definitionId}`,
        status: b.status,
        result: b.result,
        timedOut: b.timedOut,
        href: hrefOf(b.id),
      });
    }
    if (list.length) out[key] = list;
  }
  return out;
}

export type AzureQueue = {
  limit: number;
  running: number;
  queued: Array<{
    id: number;
    definitionName: string;
    repoFullName: string | null;
    headBranch: string | null;
    queuedAt: string;
    queuePosition: number | null;
  }>;
  runningBuilds: number;
};

export async function getAzureQueue(
  scope: TenantScope,
  installationId: bigint,
): Promise<AzureQueue | null> {
  guard(scope, installationId);
  const c = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: { hostedParallelJobs: true },
  });
  if (!c) return null;
  const [queued, running] = await Promise.all([
    db.azureBuild.findMany({
      where: { installationId, status: { in: ["NOT_STARTED", "POSTPONED"] } },
      orderBy: { queuedAt: "asc" },
      take: 50,
      select: {
        id: true,
        projectId: true,
        definitionId: true,
        repositoryId: true,
        headBranch: true,
        queuedAt: true,
        queuePosition: true,
      },
    }),
    db.azureBuild.count({
      where: { installationId, status: { in: ["IN_PROGRESS", "CANCELLING"] } },
    }),
  ]);
  const [names, repos] = await Promise.all([
    definitionNames(installationId, queued),
    repoNames(
      installationId,
      queued.map((q) => q.repositoryId),
    ),
  ]);
  return {
    limit: c.hostedParallelJobs,
    running,
    runningBuilds: running,
    queued: queued.map((q) => ({
      id: q.id,
      definitionName:
        names.get(`${q.projectId}:${q.definitionId}`) ?? `#${q.definitionId}`,
      repoFullName:
        q.repositoryId != null ? (repos.get(q.repositoryId) ?? null) : null,
      headBranch: q.headBranch,
      queuedAt: q.queuedAt.toISOString(),
      queuePosition: q.queuePosition,
    })),
  };
}

export type AzureCosts = {
  /** Azure Pipelines macOS minutes of the month (raw, × 1 against the free tier). */
  azureMacosMinutes: number;
  azureUsed: number;
  azureIncluded: number | null;
  /** GitHub macOS raw minutes of the same calendar month (DailyWorkflowStat). */
  githubMacosMinutes: number;
  macosMultiplier: number;
  macosPricePerMinuteUsd: number | null;
};

/** The Costs page's "Azure Pipelines" section; never feeds the GitHub estimates. */
export async function getAzureCosts(
  scope: TenantScope,
  installationId: bigint,
  month: { year: number; month: number },
  now: Date = new Date(),
): Promise<AzureCosts | null> {
  guard(scope, installationId);
  const inst = await activeInstallation(installationId);
  const c = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: { includedMinutes: true, monthResetDay: true },
  });
  if (!c) return null;
  const start = new Date(Date.UTC(month.year, month.month - 1, 1));
  const end = new Date(Date.UTC(month.year, month.month, 1));
  const [azure, gh, rate, used] = await Promise.all([
    db.dailyAzureUsage.aggregate({
      where: { installationId, day: { gte: start, lt: end } },
      _sum: { hostedMinutesMacos: true },
    }),
    db.dailyWorkflowStat.aggregate({
      where: { installationId, day: { gte: start, lt: end } },
      _sum: { jobSecondsMacos: true },
    }),
    db.skuRate.findFirst({
      where: { sku: "macos", effectiveFrom: { lte: end } },
      orderBy: { effectiveFrom: "desc" },
      select: { minuteMultiplier: true, pricePerMinuteUsd: true },
    }),
    getMinutesUsed(installationId, inst.timezone, c.monthResetDay, now),
  ]);
  return {
    azureMacosMinutes: azure._sum.hostedMinutesMacos ?? 0,
    azureUsed: used.used,
    azureIncluded: c.includedMinutes,
    githubMacosMinutes: Math.round((gh._sum.jobSecondsMacos ?? 0) / 60),
    macosMultiplier: rate ? Number(rate.minuteMultiplier) : 10,
    macosPricePerMinuteUsd: rate ? Number(rate.pricePerMinuteUsd) : null,
  };
}

/** Installation ids (of the scope) with an Azure DevOps connection. */
export async function azureConnectedIds(
  scope: TenantScope,
): Promise<Set<string>> {
  if (scope.installationIds.length === 0) return new Set();
  const rows = await db.azureDevOpsConnection.findMany({
    where: { installationId: { in: scope.installationIds } },
    select: { installationId: true },
  });
  return new Set(rows.map((r) => String(r.installationId)));
}
