import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { hasRole } from "@/server/authz/roles";
import type { TenantScope } from "@/server/authz/scope";
import { db } from "@/server/db";
import { missingOf } from "@/server/github/purposes";
import { daysBetween, rangeWindow } from "@/server/metrics/days";
import { vercelDeploymentUrl, vercelProjectUrl } from "@/server/vercel/client";
import {
  deploySuccessRate,
  fillDays,
  type DeployDay,
} from "@/lib/hosting-view";
import type { Page } from "@/lib/paging";
import type { InsightRange } from "@/lib/range";
import type {
  DeploymentFilter,
  DeploymentSortKey,
  ProjectFilter,
  ProjectSortKey,
} from "@/lib/table-specs";
import type { TableQuery } from "@/lib/url-state";
import { inScope, NotFoundError } from "./installations";

/**
 * Tenant-scoped reads and local writes of the Vercel data (design addendum
 * §3, §9). Every function takes a TenantScope and an installation id and
 * throws NotFoundError outside the scope, before any data is read; a
 * project, deployment or repository of another installation is NotFound as
 * well. DTOs carry ids as strings and times as ISO strings, never a token
 * (only its last 4 characters for admins).
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
    },
  });
  if (!inst) throw new NotFoundError();
  return inst;
}

/** The effective repository of a project: the admin override wins. */
export function effectiveRepoId(p: {
  repositoryId: bigint | null;
  manualRepositoryId: bigint | null;
}): bigint | null {
  return p.manualRepositoryId ?? p.repositoryId;
}

/** Where clause: projects whose effective repository is `repositoryId`. */
function linkedTo(repositoryId: bigint): Prisma.VercelProjectWhereInput {
  return {
    OR: [
      { manualRepositoryId: repositoryId },
      { manualRepositoryId: null, repositoryId },
    ],
  };
}

// ---------- connection ----------

export type VercelSummary = {
  connected: true;
  teamSlug: string;
  teamName: string;
  plan: string | null;
  revoked: boolean;
  lastSyncStatus: string | null;
  lastSyncedAt: string | null;
  tokenExpiresAt: string | null;
};

/** What every role may know about the connection (nav, banners); null = none. */
export async function getVercelSummary(
  scope: TenantScope,
  installationId: bigint,
): Promise<VercelSummary | null> {
  guard(scope, installationId);
  const c = await db.vercelConnection.findFirst({
    where: {
      installationId,
      installation: { deletedAt: null, suspendedAt: null },
    },
    select: {
      teamSlug: true,
      teamName: true,
      plan: true,
      revokedAt: true,
      lastSyncStatus: true,
      lastSyncedAt: true,
      tokenExpiresAt: true,
    },
  });
  if (!c) return null;
  return {
    connected: true,
    teamSlug: c.teamSlug,
    teamName: c.teamName,
    plan: c.plan,
    revoked: c.revokedAt != null,
    lastSyncStatus: c.lastSyncStatus,
    lastSyncedAt: iso(c.lastSyncedAt),
    tokenExpiresAt: iso(c.tokenExpiresAt),
  };
}

export type VercelSettings = {
  connection: null | {
    teamId: string;
    teamSlug: string;
    teamName: string;
    plan: string | null;
    tokenSource: "DB" | "ENV";
    tokenHint: string | null;
    tokenScope: string | null;
    tokenExpiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
    lastSyncStatus: string | null;
    lastSyncedAt: string | null;
    lastError: string | null;
    projectsSyncedAt: string | null;
    pausedUntil: string | null;
    createdAt: string;
  };
  /** True when the App may receive deployment_status events (hints). */
  hintsAvailable: boolean;
  /** The rate limit Vercel reported last, if any. */
  rateLimit: { limit: number; remaining: number; resetAt: string } | null;
  projects: Array<{
    id: string;
    name: string;
    linkRepo: string | null;
    repositoryId: string | null;
    manualRepositoryId: string | null;
  }>;
  /** Repositories a project may be linked to (active, not ignored). */
  repositories: Array<{ id: string; fullName: string }>;
};

/** Admin only (settings page): other roles get NotFoundError. */
export async function getVercelSettings(
  scope: TenantScope,
  installationId: bigint,
): Promise<VercelSettings> {
  guard(scope, installationId);
  if (!hasRole(scope.role, "ADMIN")) throw new NotFoundError();
  const inst = await activeInstallation(installationId);
  const [c, rate, projects, repos] = await Promise.all([
    db.vercelConnection.findUnique({ where: { installationId } }),
    db.installationRateLimit.findUnique({
      where: {
        installationId_resource: { installationId, resource: "vercel" },
      },
    }),
    db.vercelProject.findMany({
      where: { installationId, removedAt: null },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        linkRepo: true,
        repositoryId: true,
        manualRepositoryId: true,
      },
    }),
    db.repository.findMany({
      where: { installationId, removedAt: null, ignoredAt: null },
      orderBy: { fullName: "asc" },
      select: { id: true, fullName: true },
    }),
  ]);
  const permissions = (inst.permissions ?? {}) as Record<string, unknown>;
  return {
    connection: c
      ? {
          teamId: c.teamId,
          teamSlug: c.teamSlug,
          teamName: c.teamName,
          plan: c.plan,
          tokenSource: c.tokenSource,
          tokenHint: c.tokenHint,
          tokenScope: c.tokenScope,
          tokenExpiresAt: iso(c.tokenExpiresAt),
          revokedAt: iso(c.revokedAt),
          lastUsedAt: iso(c.lastUsedAt),
          lastSyncStatus: c.lastSyncStatus,
          lastSyncedAt: iso(c.lastSyncedAt),
          lastError: c.lastError,
          projectsSyncedAt: iso(c.projectsSyncedAt),
          pausedUntil: iso(c.pausedUntil),
          createdAt: c.createdAt.toISOString(),
        }
      : null,
    hintsAvailable:
      missingOf("read.deployments", permissions) === null &&
      inst.events.includes("deployment_status"),
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
      linkRepo: p.linkRepo,
      repositoryId: p.repositoryId != null ? String(p.repositoryId) : null,
      manualRepositoryId:
        p.manualRepositoryId != null ? String(p.manualRepositoryId) : null,
    })),
    repositories: repos.map((r) => ({
      id: String(r.id),
      fullName: r.fullName,
    })),
  };
}

/** Installation ids (of the scope) with a Vercel connection, for /admin/github. */
export async function vercelConnectedIds(
  scope: TenantScope,
): Promise<Set<string>> {
  if (scope.installationIds.length === 0) return new Set();
  const rows = await db.vercelConnection.findMany({
    where: { installationId: { in: scope.installationIds } },
    select: { installationId: true },
  });
  return new Set(rows.map((r) => String(r.installationId)));
}

// ---------- local writes (run by src/server/management/vercel.ts) ----------

export type ConnectionWrite = {
  teamId: string;
  teamSlug: string;
  teamName: string;
  plan: string | null;
  /** Ciphertext. */
  accessToken: string;
  tokenHint: string;
  tokenScope: string | null;
  tokenExpiresAt: Date | null;
  userId: string;
};

export async function findVercelConnection(
  scope: TenantScope,
  installationId: bigint,
) {
  guard(scope, installationId);
  return db.vercelConnection.findUnique({
    where: { installationId },
    select: { teamId: true, teamSlug: true, tokenSource: true },
  });
}

/** True when the team is connected to another installation. */
export async function teamConnectedElsewhere(
  scope: TenantScope,
  installationId: bigint,
  teamId: string,
): Promise<boolean> {
  guard(scope, installationId);
  const row = await db.vercelConnection.findUnique({
    where: { teamId },
    select: { installationId: true },
  });
  return !!row && row.installationId !== installationId;
}

export async function createVercelConnection(
  scope: TenantScope,
  installationId: bigint,
  w: ConnectionWrite,
): Promise<"created" | "taken"> {
  guard(scope, installationId);
  try {
    await db.vercelConnection.create({
      data: {
        installationId,
        teamId: w.teamId,
        teamSlug: w.teamSlug,
        teamName: w.teamName,
        plan: w.plan,
        tokenSource: "DB",
        accessToken: w.accessToken,
        tokenHint: w.tokenHint,
        tokenScope: w.tokenScope,
        tokenExpiresAt: w.tokenExpiresAt,
        createdByUserId: w.userId,
      },
    });
    return "created";
  } catch (error) {
    // Unique teamId (or a concurrent connect of this installation).
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      return "taken";
    throw error;
  }
}

export async function rotateVercelConnection(
  scope: TenantScope,
  installationId: bigint,
  w: ConnectionWrite,
): Promise<boolean> {
  guard(scope, installationId);
  const { count } = await db.vercelConnection.updateMany({
    where: { installationId, teamId: w.teamId, tokenSource: "DB" },
    data: {
      teamSlug: w.teamSlug,
      teamName: w.teamName,
      plan: w.plan,
      accessToken: w.accessToken,
      tokenHint: w.tokenHint,
      tokenScope: w.tokenScope,
      tokenExpiresAt: w.tokenExpiresAt,
      revokedAt: null,
      lastError: null,
      lastSyncStatus: null,
      pausedUntil: null,
    },
  });
  return count === 1;
}

/** Deletes the connection with its projects, deployments, stats and findings. */
export async function deleteVercelConnection(
  scope: TenantScope,
  installationId: bigint,
): Promise<boolean> {
  guard(scope, installationId);
  return db.$transaction(async (tx) => {
    const { count } = await tx.vercelConnection.deleteMany({
      where: { installationId },
    });
    await tx.dailyDeploymentStat.deleteMany({ where: { installationId } });
    await tx.finding.deleteMany({
      where: {
        installationId,
        source: { in: ["VERCEL", "CREDENTIAL"] },
        ruleKey: { startsWith: "vercel:" },
      },
    });
    await tx.installationRateLimit.deleteMany({
      where: { installationId, resource: "vercel" },
    });
    return count === 1;
  });
}

export type ProjectLinkTarget = {
  id: string;
  name: string;
  manualRepositoryId: bigint | null;
};

/** A project of the installation (NotFoundError otherwise). */
export async function findVercelProject(
  scope: TenantScope,
  installationId: bigint,
  projectId: string,
): Promise<ProjectLinkTarget> {
  guard(scope, installationId);
  const p = await db.vercelProject.findFirst({
    where: { id: projectId, installationId, removedAt: null },
    select: { id: true, name: true, manualRepositoryId: true },
  });
  if (!p) throw new NotFoundError();
  return p;
}

/** A repository a project may be linked to: same installation, active, not ignored. */
export async function findLinkableRepository(
  scope: TenantScope,
  installationId: bigint,
  repositoryId: bigint,
): Promise<{ id: bigint; fullName: string } | null> {
  guard(scope, installationId);
  return db.repository.findFirst({
    where: {
      id: repositoryId,
      installationId,
      removedAt: null,
      ignoredAt: null,
    },
    select: { id: true, fullName: true },
  });
}

export async function setVercelProjectLink(
  scope: TenantScope,
  installationId: bigint,
  projectId: string,
  repositoryId: bigint | null,
): Promise<void> {
  guard(scope, installationId);
  const { count } = await db.vercelProject.updateMany({
    where: { id: projectId, installationId },
    data: { manualRepositoryId: repositoryId },
  });
  if (count !== 1) throw new NotFoundError();
}

// ---------- deployments ----------

export type DeploymentRow = {
  id: string;
  projectId: string;
  projectName: string;
  target: string;
  state: string;
  url: string | null;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  creatorKind: string | null;
  errorCode: string | null;
  createdAt: string;
  readyAt: string | null;
  buildMs: number | null;
  repoFullName: string | null;
  /** On vercel.com, from stored ids. */
  vercelUrl: string;
  /** The live production deployment of its project. */
  live: boolean;
};

const deploymentSelect = {
  id: true,
  projectId: true,
  target: true,
  state: true,
  url: true,
  branch: true,
  commitSha: true,
  commitMessage: true,
  creatorKind: true,
  errorCode: true,
  createdAt: true,
  readyAt: true,
  buildMs: true,
  project: {
    select: {
      name: true,
      liveProdDeploymentId: true,
      repositoryId: true,
      manualRepositoryId: true,
    },
  },
} satisfies Prisma.VercelDeploymentSelect;

type DeploymentRecord = Prisma.VercelDeploymentGetPayload<{
  select: typeof deploymentSelect;
}>;

async function repoNames(
  installationId: bigint,
  ids: ReadonlyArray<bigint | null>,
): Promise<Map<bigint, string>> {
  const unique = [...new Set(ids.filter((i): i is bigint => i !== null))];
  if (unique.length === 0) return new Map();
  const rows = await db.repository.findMany({
    where: { id: { in: unique }, installationId, ignoredAt: null },
    select: { id: true, fullName: true },
  });
  return new Map(rows.map((r) => [r.id, r.fullName]));
}

function toRow(
  d: DeploymentRecord,
  teamSlug: string,
  repos: Map<bigint, string>,
): DeploymentRow {
  const repoId = effectiveRepoId(d.project);
  return {
    id: d.id,
    projectId: d.projectId,
    projectName: d.project.name,
    target: d.target,
    state: d.state,
    url: d.url,
    branch: d.branch,
    commitSha: d.commitSha,
    commitMessage: d.commitMessage,
    creatorKind: d.creatorKind,
    errorCode: d.errorCode,
    createdAt: d.createdAt.toISOString(),
    readyAt: iso(d.readyAt),
    buildMs: d.buildMs,
    repoFullName: repoId != null ? (repos.get(repoId) ?? null) : null,
    vercelUrl: vercelDeploymentUrl(teamSlug, d.project.name, d.id),
    live: d.project.liveProdDeploymentId === d.id,
  };
}

async function teamSlugOf(installationId: bigint): Promise<string | null> {
  const c = await db.vercelConnection.findUnique({
    where: { installationId },
    select: { teamSlug: true },
  });
  return c?.teamSlug ?? null;
}

export type DeploymentQuery = TableQuery<
  DeploymentSortKey,
  DeploymentFilter
> & {
  range: InsightRange;
  projectId?: string;
  repositoryId?: bigint;
};

const STATE_FILTER: Partial<Record<DeploymentFilter, string[]>> = {
  error: ["ERROR"],
  building: ["QUEUED", "INITIALIZING", "BUILDING"],
  ready: ["READY"],
  canceled: ["CANCELED"],
};

export type DeploymentFacets = {
  projects: Array<{ id: string; name: string }>;
  repos: Array<{ id: string; fullName: string }>;
};

export async function listDeployments(
  scope: TenantScope,
  installationId: bigint,
  query: DeploymentQuery,
  now: Date = new Date(),
): Promise<Page<DeploymentRow> & DeploymentFacets> {
  guard(scope, installationId);
  const inst = await activeInstallation(installationId);
  const teamSlug = await teamSlugOf(installationId);
  if (!teamSlug)
    return {
      rows: [],
      total: 0,
      page: 1,
      size: query.size,
      projects: [],
      repos: [],
    };
  const { from } = rangeWindow(query.range, now, inst.timezone);
  const targets = query.filters.filter(
    (f): f is "production" | "preview" => f === "production" || f === "preview",
  );
  const states = query.filters.flatMap((f) => STATE_FILTER[f] ?? []);
  const q = query.q?.trim();
  const where: Prisma.VercelDeploymentWhereInput = {
    installationId,
    createdAt: { gte: from },
    ...(targets.length > 0 ? { target: { in: targets } } : {}),
    ...(states.length > 0
      ? {
          state: { in: states as Prisma.EnumVercelDeploymentStateFilter["in"] },
        }
      : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.repositoryId ? { project: linkedTo(query.repositoryId) } : {}),
    ...(q
      ? {
          OR: [
            { branch: { contains: q, mode: "insensitive" } },
            { commitSha: { startsWith: q.toLowerCase() } },
            { commitMessage: { contains: q, mode: "insensitive" } },
            { project: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const dir = query.dir;
  const orderBy: Prisma.VercelDeploymentOrderByWithRelationInput[] =
    query.sort === "project"
      ? [{ project: { name: dir } }, { createdAt: "desc" }]
      : query.sort === "build"
        ? [{ buildMs: { sort: dir, nulls: "last" } }, { createdAt: "desc" }]
        : [{ createdAt: dir }, { id: "asc" }];
  const total = await db.vercelDeployment.count({ where });
  const pages = Math.max(1, Math.ceil(total / query.size));
  const page = Math.min(Math.max(1, query.page), pages);
  const [records, projects] = await Promise.all([
    db.vercelDeployment.findMany({
      where,
      orderBy,
      skip: (page - 1) * query.size,
      take: query.size,
      select: deploymentSelect,
    }),
    db.vercelProject.findMany({
      where: { installationId, removedAt: null },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        repositoryId: true,
        manualRepositoryId: true,
      },
    }),
  ]);
  const repos = await repoNames(installationId, [
    ...records.map((r) => effectiveRepoId(r.project)),
    ...projects.map(effectiveRepoId),
  ]);
  return {
    rows: records.map((r) => toRow(r, teamSlug, repos)),
    total,
    page,
    size: query.size,
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    repos: [...repos.entries()]
      .map(([id, fullName]) => ({ id: String(id), fullName }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName)),
  };
}

export type DeploymentInsights = {
  plan: string | null;
  production: number;
  preview: number;
  /** READY / (READY + ERROR) of production deployments in the range. */
  prodSuccessRate: number | null;
  failures: number;
  buildP50Ms: number | null;
  buildP90Ms: number | null;
  /** Projects whose newest production deployment failed. */
  failingProjects: number;
  /** Deployments created in the last 24 h (the Hobby allotment's window). */
  last24h: number;
  perDay: DeployDay[];
};

export async function getDeploymentInsights(
  scope: TenantScope,
  installationId: bigint,
  range: InsightRange,
  now: Date = new Date(),
): Promise<DeploymentInsights | null> {
  guard(scope, installationId);
  const inst = await activeInstallation(installationId);
  const conn = await db.vercelConnection.findUnique({
    where: { installationId },
    select: { plan: true },
  });
  if (!conn) return null;
  const w = rangeWindow(range, now, inst.timezone);
  const [byTarget, prod, builds, failing, last24h, stats] = await Promise.all([
    db.vercelDeployment.groupBy({
      by: ["target"],
      where: { installationId, createdAt: { gte: w.from } },
      _count: { _all: true },
    }),
    db.vercelDeployment.groupBy({
      by: ["state"],
      where: {
        installationId,
        createdAt: { gte: w.from },
        target: "production",
      },
      _count: { _all: true },
    }),
    db.$queryRaw<Array<{ p50: number | null; p90: number | null }>>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY "buildMs") AS p50,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY "buildMs") AS p90
      FROM "VercelDeployment"
      WHERE "installationId" = ${installationId} AND "createdAt" >= ${w.from}
        AND "buildMs" IS NOT NULL`,
    db.vercelProject.count({
      where: { installationId, removedAt: null, latestProdState: "ERROR" },
    }),
    db.vercelDeployment.count({
      where: {
        installationId,
        createdAt: { gte: new Date(now.getTime() - DAY_MS) },
      },
    }),
    db.dailyDeploymentStat.findMany({
      where: {
        installationId,
        day: {
          gte: new Date(`${w.fromDay}T00:00:00Z`),
          lte: new Date(`${w.toDay}T00:00:00Z`),
        },
      },
      select: {
        day: true,
        total: true,
        ready: true,
        error: true,
        canceled: true,
      },
    }),
  ]);
  const count = (t: string) =>
    byTarget.find((b) => b.target === t)?._count._all ?? 0;
  const state = (s: string) =>
    prod.find((p) => p.state === s)?._count._all ?? 0;
  const failures = await db.vercelDeployment.count({
    where: { installationId, createdAt: { gte: w.from }, state: "ERROR" },
  });
  return {
    plan: conn.plan,
    production: count("production"),
    preview: count("preview") + count("staging"),
    prodSuccessRate: deploySuccessRate(state("READY"), state("ERROR")),
    failures,
    buildP50Ms:
      builds[0]?.p50 == null ? null : Math.round(Number(builds[0].p50)),
    buildP90Ms:
      builds[0]?.p90 == null ? null : Math.round(Number(builds[0].p90)),
    failingProjects: failing,
    last24h,
    perDay: fillDays(
      daysBetween(w.fromDay, w.toDay),
      stats.map((s) => ({ ...s, day: s.day.toISOString().slice(0, 10) })),
    ),
  };
}

// ---------- projects ----------

export type ProjectRow = {
  id: string;
  name: string;
  framework: string | null;
  linkRepo: string | null;
  repoFullName: string | null;
  manualLink: boolean;
  productionBranch: string | null;
  latestProdState: string | null;
  latestProdAt: string | null;
  latestProdSha: string | null;
  autoAssignPausedAt: string | null;
  paused: boolean;
  vercelUrl: string;
  recent: DeploymentRow[];
};

export type ProjectQuery = TableQuery<ProjectSortKey, ProjectFilter>;

export async function listVercelProjects(
  scope: TenantScope,
  installationId: bigint,
  query: ProjectQuery,
): Promise<Page<ProjectRow>> {
  guard(scope, installationId);
  await activeInstallation(installationId);
  const teamSlug = await teamSlugOf(installationId);
  if (!teamSlug) return { rows: [], total: 0, page: 1, size: query.size };
  const q = query.q?.trim();
  const and: Prisma.VercelProjectWhereInput[] = [];
  if (query.filters.includes("failing")) and.push({ latestProdState: "ERROR" });
  if (query.filters.includes("paused"))
    and.push({
      OR: [{ autoAssignPausedAt: { not: null } }, { pausedAt: { not: null } }],
    });
  if (query.filters.includes("unlinked"))
    and.push({ repositoryId: null, manualRepositoryId: null });
  if (q) and.push({ name: { contains: q, mode: "insensitive" } });
  const where: Prisma.VercelProjectWhereInput = {
    installationId,
    removedAt: null,
    ...(and.length > 0 ? { AND: and } : {}),
  };
  const orderBy: Prisma.VercelProjectOrderByWithRelationInput[] =
    query.sort === "latest"
      ? [
          { latestProdReadyAt: { sort: query.dir, nulls: "last" } },
          { name: "asc" },
        ]
      : [{ name: query.dir }];
  const total = await db.vercelProject.count({ where });
  const pages = Math.max(1, Math.ceil(total / query.size));
  const page = Math.min(Math.max(1, query.page), pages);
  const projects = await db.vercelProject.findMany({
    where,
    orderBy,
    skip: (page - 1) * query.size,
    take: query.size,
    select: {
      id: true,
      name: true,
      framework: true,
      linkRepo: true,
      repositoryId: true,
      manualRepositoryId: true,
      productionBranch: true,
      latestProdDeploymentId: true,
      latestProdState: true,
      latestProdReadyAt: true,
      autoAssignPausedAt: true,
      pausedAt: true,
    },
  });
  const ids = projects.map((p) => p.id);
  const recent = ids.length
    ? await db.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM (
          SELECT "id", row_number() OVER (PARTITION BY "projectId" ORDER BY "createdAt" DESC) AS rn
          FROM "VercelDeployment"
          WHERE "installationId" = ${installationId} AND "projectId" = ANY(${ids})
        ) t WHERE rn <= 10`
    : [];
  const records = recent.length
    ? await db.vercelDeployment.findMany({
        where: { installationId, id: { in: recent.map((r) => r.id) } },
        orderBy: { createdAt: "desc" },
        select: deploymentSelect,
      })
    : [];
  const repos = await repoNames(installationId, projects.map(effectiveRepoId));
  const latest = new Map(records.map((r) => [r.id, r]));
  return {
    rows: projects.map((p) => {
      const repoId = effectiveRepoId(p);
      const prod = p.latestProdDeploymentId
        ? latest.get(p.latestProdDeploymentId)
        : undefined;
      return {
        id: p.id,
        name: p.name,
        framework: p.framework,
        linkRepo: p.linkRepo,
        repoFullName: repoId != null ? (repos.get(repoId) ?? null) : null,
        manualLink: p.manualRepositoryId != null,
        productionBranch: p.productionBranch,
        latestProdState: p.latestProdState,
        latestProdAt: iso(p.latestProdReadyAt ?? prod?.createdAt),
        latestProdSha: prod?.commitSha ?? null,
        autoAssignPausedAt: iso(p.autoAssignPausedAt),
        paused: p.pausedAt != null,
        vercelUrl: vercelProjectUrl(teamSlug, p.name),
        recent: records
          .filter((r) => r.projectId === p.id)
          .map((r) => toRow(r, teamSlug, repos)),
      };
    }),
    total,
    page,
    size: query.size,
  };
}

// ---------- repository card, PR and run badges ----------

export type RepoDeploymentCard = {
  projectId: string;
  projectName: string;
  manualLink: boolean;
  productionBranch: string | null;
  vercelUrl: string;
  production: DeploymentRow | null;
  live: DeploymentRow | null;
  latestPreview: DeploymentRow | null;
  recent: DeploymentRow[];
  autoAssignPausedAt: string | null;
};

/**
 * The Deployments card of a repository page: one entry per project linked
 * to the repository. A foreign, removed or ignored repository is NotFound.
 */
export async function getRepoDeployments(
  scope: TenantScope,
  installationId: bigint,
  repositoryId: bigint,
): Promise<RepoDeploymentCard[]> {
  guard(scope, installationId);
  await activeInstallation(installationId);
  const repo = await db.repository.findFirst({
    where: {
      id: repositoryId,
      installationId,
      removedAt: null,
      ignoredAt: null,
    },
    select: { id: true, fullName: true },
  });
  if (!repo) throw new NotFoundError();
  const teamSlug = await teamSlugOf(installationId);
  if (!teamSlug) return [];
  const projects = await db.vercelProject.findMany({
    where: { installationId, removedAt: null, ...linkedTo(repositoryId) },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      manualRepositoryId: true,
      productionBranch: true,
      latestProdDeploymentId: true,
      liveProdDeploymentId: true,
      autoAssignPausedAt: true,
    },
  });
  const repos = new Map([[repo.id, repo.fullName]]);
  const out: RepoDeploymentCard[] = [];
  for (const p of projects) {
    const [recent, preview, prod, live] = await Promise.all([
      db.vercelDeployment.findMany({
        where: { installationId, projectId: p.id },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: deploymentSelect,
      }),
      db.vercelDeployment.findFirst({
        where: { installationId, projectId: p.id, target: "preview" },
        orderBy: { createdAt: "desc" },
        select: deploymentSelect,
      }),
      p.latestProdDeploymentId
        ? db.vercelDeployment.findFirst({
            where: { installationId, id: p.latestProdDeploymentId },
            select: deploymentSelect,
          })
        : Promise.resolve(null),
      p.liveProdDeploymentId
        ? db.vercelDeployment.findFirst({
            where: { installationId, id: p.liveProdDeploymentId },
            select: deploymentSelect,
          })
        : Promise.resolve(null),
    ]);
    out.push({
      projectId: p.id,
      projectName: p.name,
      manualLink: p.manualRepositoryId != null,
      productionBranch: p.productionBranch,
      vercelUrl: vercelProjectUrl(teamSlug, p.name),
      production: prod ? toRow(prod, teamSlug, repos) : null,
      live: live ? toRow(live, teamSlug, repos) : null,
      latestPreview: preview ? toRow(preview, teamSlug, repos) : null,
      recent: recent.map((r) => toRow(r, teamSlug, repos)),
      autoAssignPausedAt: iso(p.autoAssignPausedAt),
    });
  }
  return out;
}

export type ShaDeployment = {
  target: string;
  state: string;
  url: string | null;
  projectName: string;
  vercelUrl: string;
};

/**
 * The newest deployment per commit SHA (and per target) of the
 * installation's projects, for the preview badge on pull requests and
 * "Deployed as" on runs. Keys are lowercase SHAs.
 */
export async function deploymentsForShas(
  scope: TenantScope,
  installationId: bigint,
  shas: ReadonlyArray<string>,
): Promise<Map<string, ShaDeployment[]>> {
  guard(scope, installationId);
  const unique = [
    ...new Set(
      shas
        .map((s) => s.toLowerCase())
        .filter((s) => /^[0-9a-f]{7,64}$/.test(s)),
    ),
  ].slice(0, 500);
  const out = new Map<string, ShaDeployment[]>();
  if (unique.length === 0) return out;
  const teamSlug = await teamSlugOf(installationId);
  if (!teamSlug) return out;
  const rows = await db.vercelDeployment.findMany({
    where: {
      installationId,
      commitSha: { in: unique },
      project: { removedAt: null },
    },
    orderBy: { createdAt: "desc" },
    take: 2000,
    select: {
      id: true,
      commitSha: true,
      target: true,
      state: true,
      url: true,
      projectId: true,
      project: { select: { name: true } },
    },
  });
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.commitSha}:${r.projectId}:${r.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = out.get(r.commitSha!) ?? [];
    list.push({
      target: r.target,
      state: r.state,
      url: r.url,
      projectName: r.project.name,
      vercelUrl: vercelDeploymentUrl(teamSlug, r.project.name, r.id),
    });
    out.set(r.commitSha!, list);
  }
  return out;
}

// ---------- needs attention (findings) ----------

export type AttentionItem = {
  id: string;
  kind: string;
  severity: string;
  title: string;
  projectName: string | null;
  externalUrl: string | null;
  since: string;
  /** e.g. the token expiry or the pause start. */
  at: string | null;
  repoFullName: string | null;
};

const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

/** Open findings of the installation, most severe first. */
export async function listNeedsAttention(
  scope: TenantScope,
  installationId: bigint,
  limit = 20,
): Promise<AttentionItem[]> {
  guard(scope, installationId);
  await activeInstallation(installationId);
  const rows = await db.finding.findMany({
    where: { installationId, status: "OPEN" },
    orderBy: [{ lastSeenAt: "desc" }],
    take: 200,
  });
  const details = rows.map((r) => (r.details ?? {}) as Record<string, unknown>);
  const repoIds = details.map((d) =>
    typeof d.repositoryId === "string" ? BigInt(d.repositoryId) : null,
  );
  const repos = await repoNames(installationId, repoIds);
  return rows
    .map((r, i) => {
      const d = details[i]!;
      const str = (k: string) =>
        typeof d[k] === "string" ? (d[k] as string) : null;
      const repoId = repoIds[i];
      return {
        id: r.id,
        kind: str("kind") ?? r.source.toLowerCase(),
        severity: r.severity,
        title: r.title,
        projectName: str("projectName"),
        externalUrl:
          r.externalUrl &&
          /^https:\/\/(vercel\.com|github\.com)\//.test(r.externalUrl)
            ? r.externalUrl
            : null,
        since: r.firstSeenAt.toISOString(),
        at: str("expiresAt") ?? str("since"),
        repoFullName: repoId != null ? (repos.get(repoId) ?? null) : null,
      };
    })
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) -
          SEVERITY_ORDER.indexOf(b.severity) || b.since.localeCompare(a.since),
    )
    .slice(0, limit);
}

// ---------- dashboard ----------

export type HostingCard = {
  installationId: string;
  accountLogin: string;
  teamSlug: string;
  plan: string | null;
  revoked: boolean;
  failingProjects: number;
  last24h: number;
  openFindings: number;
  lastSyncedAt: string | null;
};

/** One hosting card per visible installation with a connection. */
export async function getHostingCards(
  scope: TenantScope,
  now: Date = new Date(),
): Promise<HostingCard[]> {
  if (scope.installationIds.length === 0) return [];
  const conns = await db.vercelConnection.findMany({
    where: {
      installationId: { in: scope.installationIds },
      installation: { deletedAt: null, suspendedAt: null },
    },
    select: {
      installationId: true,
      teamSlug: true,
      plan: true,
      revokedAt: true,
      lastSyncedAt: true,
      installation: { select: { accountLogin: true } },
    },
    orderBy: { installation: { accountLogin: "asc" } },
  });
  const out: HostingCard[] = [];
  for (const c of conns) {
    const id = c.installationId;
    const [failing, last24h, findings] = await Promise.all([
      db.vercelProject.count({
        where: {
          installationId: id,
          removedAt: null,
          latestProdState: "ERROR",
        },
      }),
      db.vercelDeployment.count({
        where: {
          installationId: id,
          createdAt: { gte: new Date(now.getTime() - DAY_MS) },
        },
      }),
      db.finding.count({ where: { installationId: id, status: "OPEN" } }),
    ]);
    out.push({
      installationId: String(id),
      accountLogin: c.installation.accountLogin,
      teamSlug: c.teamSlug,
      plan: c.plan,
      revoked: c.revokedAt != null,
      failingProjects: failing,
      last24h,
      openFindings: findings,
      lastSyncedAt: iso(c.lastSyncedAt),
    });
  }
  return out;
}
