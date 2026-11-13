import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { env } from "@/env";
import { billingMonth } from "@/lib/azure-usage";
import {
  AzureError,
  createAzureClient,
  PASS_REQUEST_CAP,
  type AzureBuildRaw,
  type AzureRateInfo,
  type AzureReadApi,
  type Fetch,
} from "@/server/azure/client";
import { EntraError } from "@/server/azure/entra";
import {
  deriveBuild,
  mapBuild,
  mapTimeline,
  osOf,
  previousTimelines,
  type BuildRow,
  type JobRow,
} from "@/server/azure/map";
import { db } from "@/server/db";
import { localDay } from "@/server/metrics/days";
import { ensureAzureEnvConnection, storeProjects } from "./azure-connect";
import {
  azureCredentialFor,
  envAzureCredential,
  markAzureRevoked,
  touchAzureUse,
  type EnvAzureCredential,
} from "./azure-credential";
import {
  updateAzureCredentialFindings,
  updateAzureFindings,
} from "./azure-findings";
import { drainPipelineRollups } from "./azure-rollup";
import {
  computeDailyUsage,
  usageDays,
  writeEstimateSnapshot,
} from "./azure-usage";
import { Deadline, DeadlineReached } from "./budget";
import { stepDeadline } from "./provider-step";
import { scrubKnown } from "./webhook";

/**
 * Reconcile step "z" (design addendum M7 §4): the Azure Pipelines data of
 * one installation, read-only, bounded by its own budget and at most 80
 * requests per pass, resumable from cursors stored per project.
 *
 *   z1 definitions   every 6 h, on Sync now, after a hint for an unknown build
 *   z2a open builds  every pass: non-completed rows by buildIds (≤ 100)
 *   z2b new builds   every pass: minTime = cursor − 10 min, queueTimeAscending,
 *                    $top 100, continuation; the cursor moves only when the
 *                    chain is complete; only linked definitions are stored
 *   z2c retry sweep  every 30 min: completed in the last 48 h, finishTimeDescending
 *                    (catches retries of builds that had already finished)
 *   z2d backfill     full passes, at most 50 % of the budget, newest first,
 *                    down to the raw retention
 *   z3 timelines     ≤ 15 builds: dirty, then open (every 60 s), then changed
 *   z4 pools         every 2 min: pools, self-hosted agents, job requests
 *   z5 usage         every 6 h (or on the Usage page): resourceusage (preview)
 *   z6 hooks health  every 6 h: our service hook subscriptions
 *   z7 rollup        DB only: DailyPipelineStat, DailyAzureUsage, findings
 *
 * Stop rules: any Retry-After (also on a 200), less than 20 % of the rate
 * budget, a 429 or TF400733 end the step and set `pausedUntil`. A 401, 203
 * or a rejected service principal secret revokes the connection (no further
 * calls until a rotate). Every error text is scrubbed of the credential and
 * the organisation name.
 */

export const AZURE_STEP_BUDGET_MS = 30_000;
export const AZURE_FAST_BUDGET_MS = 8_000;
const REQUEST_RESERVE_MS = 1_500;
const DEFINITIONS_MAX_AGE_MS = 6 * 3_600_000;
const POOLS_MAX_AGE_MS = 2 * 60_000;
const USAGE_MAX_AGE_MS = 6 * 3_600_000;
const HOOKS_MAX_AGE_MS = 6 * 3_600_000;
const SWEEP_EVERY_MS = 30 * 60_000;
const CURSOR_OVERLAP_MS = 10 * 60_000;
const FIRST_PASS_MS = 2 * 86_400_000;
const OPEN_TIMELINE_EVERY_MS = 60_000;
const TIMELINES_PER_PASS = 15;
const FAST_REQUEST_CAP = 24;
const DAY_MS = 86_400_000;
const JOB_REQUEST_DAYS = 35;
const PROBABLE_WINDOW_MS = 2 * 60_000;

export type AzureStepStatus =
  "none" | "ok" | "partial" | "rate_limited" | "credential_error" | "error";

export type AzureStepResult = {
  status: AzureStepStatus;
  reason?: string;
  definitions: number;
  builds: number;
  timelines: number;
  requests: number;
};

export type AzureStepOptions = {
  installationId: bigint;
  timezone: string;
  /** Raw retention in days (null = unlimited, backfill then 90 days). */
  retentionDays: number | null;
  deadline: Deadline;
  /** "fast": the lazy path (z2a, z2b, z3, z7; z1 only when never synced). */
  mode?: "full" | "fast";
  /** Sync now: z1 runs regardless of its age. */
  forceDefinitions?: boolean;
  /** Usage page: z5 if older than 10 minutes. */
  forceUsage?: boolean;
  budgetMs?: number;
  fetch?: Fetch;
  envCredential?: EnvAzureCredential | null;
};

export type ConnRow = {
  orgName: string;
  orgId: string;
  revokedAt: Date | null;
  pausedUntil: Date | null;
  definitionsSyncedAt: Date | null;
  poolsSampledAt: Date | null;
  usageSyncedAt: Date | null;
  hooksCheckedAt: Date | null;
  sweepAt: Date | null;
  lastSyncedAt: Date | null;
  maxJobMinutes: number;
  hostedParallelJobs: number;
  includedMinutes: number | null;
  monthResetDay: number;
  hookKey: string | null;
  jobRequestsAvailable: boolean | null;
};

type Ctx = {
  installationId: bigint;
  timezone: string;
  api: AzureReadApi;
  deadline: Deadline;
  now: Date;
  conn: ConnRow;
  secrets: string[];
  result: AzureStepResult;
  /** Local days whose pipeline stats must be recomputed. */
  days: Set<string>;
  /** Local days whose hosted usage must be recomputed. */
  usageDays: Set<string>;
  retentionDays: number | null;
};

const empty = (status: AzureStepStatus): AzureStepResult => ({
  status,
  definitions: 0,
  builds: 0,
  timelines: 0,
  requests: 0,
});

/** The read client of a step: deadline-bound timeouts and the request cap. */
export function azureApiFor(
  org: string,
  auth: Parameters<typeof createAzureClient>[0]["auth"],
  deadline: Deadline,
  fetchImpl: Fetch | undefined,
  hooks: { onRate?: (r: AzureRateInfo) => void; maxRequests?: number } = {},
): AzureReadApi {
  return createAzureClient({
    org,
    auth,
    fetch: fetchImpl,
    now: () => deadline.now(),
    timeoutMs: () => Math.min(8_000, deadline.remainingMs() - 500),
    beforeRequest: () => {
      if (deadline.expired(REQUEST_RESERVE_MS)) throw new DeadlineReached();
    },
    onRate: hooks.onRate,
    maxRequests: hooks.maxRequests ?? PASS_REQUEST_CAP,
  });
}

export const CONN_SELECT = {
  orgName: true,
  orgId: true,
  revokedAt: true,
  pausedUntil: true,
  definitionsSyncedAt: true,
  poolsSampledAt: true,
  usageSyncedAt: true,
  hooksCheckedAt: true,
  sweepAt: true,
  lastSyncedAt: true,
  maxJobMinutes: true,
  hostedParallelJobs: true,
  includedMinutes: true,
  monthResetDay: true,
  hookKey: true,
  jobRequestsAvailable: true,
} satisfies Prisma.AzureDevOpsConnectionSelect;

// ---------- definitions (z1) ----------

type DefLink = {
  repositoryId: bigint | null;
  defaultBranch: string | null;
  osOverride: "LINUX" | "WINDOWS" | "MACOS" | "UNKNOWN" | null;
};

/** The effective repository and branch info of every stored definition. */
async function definitionLinks(
  installationId: bigint,
): Promise<Map<string, DefLink>> {
  const defs = await db.azurePipelineDefinition.findMany({
    where: { installationId, removedAt: null },
    select: {
      projectId: true,
      id: true,
      repositoryId: true,
      manualRepositoryId: true,
      defaultBranch: true,
      osOverride: true,
    },
  });
  const repoIds = [
    ...new Set(
      defs
        .map((d) => d.manualRepositoryId ?? d.repositoryId)
        .filter((x): x is bigint => x != null),
    ),
  ];
  const active = new Map(
    (
      await db.repository.findMany({
        where: {
          installationId,
          id: { in: repoIds },
          removedAt: null,
          ignoredAt: null,
        },
        select: { id: true, defaultBranch: true },
      })
    ).map((r) => [r.id, r]),
  );
  const out = new Map<string, DefLink>();
  for (const d of defs) {
    const rid = d.manualRepositoryId ?? d.repositoryId;
    const repo = rid != null ? active.get(rid) : undefined;
    out.set(`${d.projectId}:${d.id}`, {
      repositoryId: repo ? repo.id : null,
      defaultBranch: d.defaultBranch ?? repo?.defaultBranch ?? null,
      osOverride: d.osOverride,
    });
  }
  return out;
}

async function syncDefinitions(ctx: Ctx): Promise<void> {
  const { installationId } = ctx;
  // The project list (names, visibility, new and removed projects).
  const projects = [];
  let cont: string | null = null;
  for (let page = 0; page < 5; page++) {
    const r = await ctx.api.listProjects(cont);
    projects.push(...r.projects);
    if (!r.continuation || r.projects.length === 0) break;
    cont = r.continuation;
  }
  await storeProjects(installationId, projects, { applySuggestion: false });
  const repos = new Map(
    (
      await db.repository.findMany({
        where: { installationId, removedAt: null, ignoredAt: null },
        select: { id: true, fullName: true },
      })
    ).map((r) => [r.fullName.toLowerCase(), r.id]),
  );
  const selected = await db.azureDevOpsProject.findMany({
    where: { installationId, selected: true, removedAt: null },
    select: { id: true },
  });
  for (const p of selected) {
    const seen: number[] = [];
    let continuation: string | null = null;
    let complete = false;
    for (let page = 0; page < 10; page++) {
      const r = await ctx.api.listDefinitions(p.id, continuation);
      for (const d of r.definitions) {
        seen.push(d.id);
        const repositoryId = d.repoFullName
          ? (repos.get(d.repoFullName.toLowerCase()) ?? null)
          : null;
        const before = await db.azurePipelineDefinition.findUnique({
          where: {
            installationId_projectId_id: {
              installationId,
              projectId: p.id,
              id: d.id,
            },
          },
          select: { repositoryId: true, manualRepositoryId: true },
        });
        const data = {
          name: d.name,
          path: d.path,
          yamlPath: d.yamlPath,
          repoType: d.repoType,
          linkRepoFullName: d.repoFullName,
          repositoryId,
          defaultBranch: d.defaultBranch,
          queueStatus: d.queueStatus,
          removedAt: null,
        };
        await db.azurePipelineDefinition.upsert({
          where: {
            installationId_projectId_id: {
              installationId,
              projectId: p.id,
              id: d.id,
            },
          },
          create: { installationId, projectId: p.id, id: d.id, ...data },
          update: data,
        });
        // A newly linked definition is backfilled: the project scans back again.
        const wasLinked =
          before && (before.manualRepositoryId ?? before.repositoryId) != null;
        if (repositoryId != null && !wasLinked)
          await db.azureDevOpsProject.updateMany({
            where: { installationId, id: p.id },
            data: { backfillDone: false, backfillBefore: ctx.now },
          });
        ctx.result.definitions++;
      }
      if (!r.continuation || r.definitions.length === 0) {
        complete = true;
        break;
      }
      continuation = r.continuation;
    }
    if (complete)
      await db.azurePipelineDefinition.updateMany({
        where: {
          installationId,
          projectId: p.id,
          removedAt: null,
          id: { notIn: seen },
        },
        data: { removedAt: ctx.now },
      });
  }
  await db.azureDevOpsConnection.updateMany({
    where: { installationId },
    data: { definitionsSyncedAt: ctx.now },
  });
}

// ---------- builds (z2) ----------

/**
 * Upserts build snapshots of linked definitions (an already stored build
 * keeps updating). Applied only when its lastChangedDate is not older than
 * the stored one, so a stale page never rolls a build back; a retry
 * (COMPLETED → IN_PROGRESS) carries a newer lastChangedDate and passes.
 * Tags `dm-audit-<id>` link M7b queue rows of this installation ("exact").
 */
export async function upsertBuilds(
  installationId: bigint,
  timezone: string,
  raws: ReadonlyArray<AzureBuildRaw>,
  projectId: string,
  now: Date,
  days?: Set<string>,
  links?: Map<string, DefLink>,
): Promise<number> {
  if (raws.length === 0) return 0;
  const defLinks = links ?? (await definitionLinks(installationId));
  const rows = raws
    .map((b) => mapBuild(b, projectId))
    .filter((b): b is BuildRow => b !== null);
  const existing = new Map(
    (
      await db.azureBuild.findMany({
        where: { installationId, id: { in: rows.map((r) => r.id) } },
        select: {
          id: true,
          lastChangedAt: true,
          status: true,
          projectId: true,
        },
      })
    ).map((r) => [r.id, r]),
  );
  const tagIds = [
    ...new Set(rows.map((r) => r.auditTag).filter((x): x is string => !!x)),
  ];
  const audits = new Set(
    tagIds.length
      ? (
          await db.auditLog.findMany({
            where: {
              id: { in: tagIds },
              installationId,
              action: "ADO_QUEUE_RUN",
            },
            select: { id: true },
          })
        ).map((a) => a.id)
      : [],
  );
  let n = 0;
  for (const b of rows) {
    const link = defLinks.get(`${b.projectId}:${b.definitionId}`);
    const prev = existing.get(b.id);
    if (!prev && (!link || link.repositoryId == null)) continue;
    if (prev && prev.projectId !== b.projectId) continue;
    if (
      prev?.lastChangedAt &&
      b.lastChangedAt &&
      b.lastChangedAt < prev.lastChangedAt
    )
      continue;
    const data = {
      projectId: b.projectId,
      definitionId: b.definitionId,
      ...(link ? { repositoryId: link.repositoryId } : {}),
      buildNumber: b.buildNumber,
      status: b.status,
      result: b.result,
      reason: b.reason,
      headBranch: b.headBranch,
      headSha: b.headSha,
      prNumber: b.prNumber,
      isDefaultBranch:
        !!b.headBranch &&
        !!link?.defaultBranch &&
        b.headBranch === link.defaultBranch &&
        b.prNumber == null,
      queuedAt: b.queuedAt,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
      durationS: b.durationS,
      queuePosition: b.queuePosition,
      lastChangedAt: b.lastChangedAt,
      syncedAt: now,
      ...(b.status !== "COMPLETED" ? { firstAttemptResult: null } : {}),
    };
    const audit =
      b.auditTag && audits.has(b.auditTag)
        ? { auditLogId: b.auditTag, auditLinkKind: "exact" }
        : {};
    await db.azureBuild.upsert({
      where: { installationId_id: { installationId, id: b.id } },
      create: { installationId, id: b.id, ...data, ...audit },
      update: { ...data, ...audit },
    });
    days?.add(localDay(b.queuedAt, timezone));
    n++;
  }
  return n;
}

/** Linked definition ids per selected project. */
async function linkedByProject(
  installationId: bigint,
  links: Map<string, DefLink>,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const projects = await db.azureDevOpsProject.findMany({
    where: { installationId, selected: true, removedAt: null },
    select: { id: true },
  });
  for (const p of projects) out.set(p.id, []);
  for (const [key, l] of links) {
    if (l.repositoryId == null) continue;
    const [projectId, id] = key.split(":") as [string, string];
    out.get(projectId)?.push(Number(id));
  }
  return out;
}

async function refreshOpenBuilds(
  ctx: Ctx,
  links: Map<string, DefLink>,
): Promise<void> {
  const open = await db.azureBuild.findMany({
    where: { installationId: ctx.installationId, status: { not: "COMPLETED" } },
    orderBy: { queuedAt: "desc" },
    take: 300,
    select: { id: true, projectId: true },
  });
  const byProject = new Map<string, number[]>();
  for (const b of open)
    byProject.set(b.projectId, [...(byProject.get(b.projectId) ?? []), b.id]);
  for (const [projectId, ids] of byProject) {
    for (let i = 0; i < ids.length; i += 100) {
      const r = await ctx.api.listBuilds(projectId, {
        buildIds: ids.slice(i, i + 100),
        top: 100,
      });
      ctx.result.builds += await upsertBuilds(
        ctx.installationId,
        ctx.timezone,
        r.builds,
        projectId,
        ctx.now,
        ctx.days,
        links,
      );
    }
  }
}

async function syncNewBuilds(
  ctx: Ctx,
  links: Map<string, DefLink>,
): Promise<void> {
  const linked = await linkedByProject(ctx.installationId, links);
  for (const [projectId, defs] of linked) {
    if (defs.length === 0) continue;
    const p = await db.azureDevOpsProject.findUnique({
      where: {
        installationId_id: {
          installationId: ctx.installationId,
          id: projectId,
        },
      },
      select: {
        buildsCursor: true,
        buildsContinuation: true,
        buildsPassTop: true,
        backfillBefore: true,
        backfillDone: true,
      },
    });
    if (!p) continue;
    const firstPass = !p.buildsCursor && !p.buildsContinuation;
    const minTime = p.buildsCursor
      ? new Date(p.buildsCursor.getTime() - CURSOR_OVERLAP_MS)
      : new Date(ctx.now.getTime() - FIRST_PASS_MS);
    if (firstPass && !p.backfillBefore && !p.backfillDone)
      await db.azureDevOpsProject.updateMany({
        where: { installationId: ctx.installationId, id: projectId },
        data: { backfillBefore: minTime },
      });
    let continuation = p.buildsContinuation;
    let top = p.buildsPassTop?.getTime() ?? null;
    for (;;) {
      const r = await ctx.api.listBuilds(projectId, {
        minTime,
        queryOrder: "queueTimeAscending",
        definitions: defs,
        top: 100,
        continuation,
      });
      ctx.result.builds += await upsertBuilds(
        ctx.installationId,
        ctx.timezone,
        r.builds,
        projectId,
        ctx.now,
        ctx.days,
        links,
      );
      for (const b of r.builds) {
        const t = b.queueTime ? Date.parse(b.queueTime) : NaN;
        if (Number.isFinite(t)) top = Math.max(top ?? 0, t);
      }
      if (!r.continuation || r.builds.length === 0) {
        const cursor =
          top != null
            ? new Date(Math.min(top, ctx.now.getTime()))
            : (p.buildsCursor ?? minTime);
        await db.azureDevOpsProject.updateMany({
          where: { installationId: ctx.installationId, id: projectId },
          data: {
            buildsCursor: cursor,
            buildsContinuation: null,
            buildsPassTop: null,
          },
        });
        break;
      }
      continuation = r.continuation;
      // Persist the resume point after every page, so a deadline loses nothing.
      await db.azureDevOpsProject.updateMany({
        where: { installationId: ctx.installationId, id: projectId },
        data: {
          buildsContinuation: continuation,
          buildsPassTop: top != null ? new Date(top) : null,
        },
      });
    }
  }
}

/** z2c: completed in the last 48 h (catches retries of finished builds). */
async function sweepFinished(
  ctx: Ctx,
  links: Map<string, DefLink>,
): Promise<void> {
  const linked = await linkedByProject(ctx.installationId, links);
  for (const [projectId, defs] of linked) {
    if (defs.length === 0) continue;
    const r = await ctx.api.listBuilds(projectId, {
      minTime: new Date(ctx.now.getTime() - 2 * DAY_MS),
      queryOrder: "finishTimeDescending",
      statusFilter: "completed",
      definitions: defs,
      top: 100,
    });
    ctx.result.builds += await upsertBuilds(
      ctx.installationId,
      ctx.timezone,
      r.builds,
      projectId,
      ctx.now,
      ctx.days,
      links,
    );
  }
  await db.azureDevOpsConnection.updateMany({
    where: { installationId: ctx.installationId },
    data: { sweepAt: ctx.now },
  });
}

/** z2d: older builds, newest first, down to the raw retention; at most half the budget. */
async function backfill(
  ctx: Ctx,
  links: Map<string, DefLink>,
  until: number,
): Promise<void> {
  const linked = await linkedByProject(ctx.installationId, links);
  const cutoff = ctx.now.getTime() - (ctx.retentionDays ?? 90) * DAY_MS;
  for (const [projectId, defs] of linked) {
    if (defs.length === 0) continue;
    for (;;) {
      if (ctx.deadline.now() >= until) return;
      const p = await db.azureDevOpsProject.findUnique({
        where: {
          installationId_id: {
            installationId: ctx.installationId,
            id: projectId,
          },
        },
        select: { backfillBefore: true, backfillDone: true },
      });
      if (!p || p.backfillDone || !p.backfillBefore) break;
      if (p.backfillBefore.getTime() <= cutoff) {
        await db.azureDevOpsProject.updateMany({
          where: { installationId: ctx.installationId, id: projectId },
          data: { backfillDone: true },
        });
        break;
      }
      const r = await ctx.api.listBuilds(projectId, {
        maxTime: p.backfillBefore,
        queryOrder: "queueTimeDescending",
        definitions: defs,
        top: 100,
      });
      ctx.result.builds += await upsertBuilds(
        ctx.installationId,
        ctx.timezone,
        r.builds.filter(
          (b) => !b.queueTime || Date.parse(b.queueTime) >= cutoff,
        ),
        projectId,
        ctx.now,
        ctx.days,
        links,
      );
      const oldest = Math.min(
        ...r.builds.map((b) =>
          b.queueTime ? Date.parse(b.queueTime) : Infinity,
        ),
      );
      const done =
        r.builds.length < 100 || !Number.isFinite(oldest) || oldest <= cutoff;
      const next = Number.isFinite(oldest)
        ? new Date(Math.min(oldest, p.backfillBefore.getTime() - 1))
        : p.backfillBefore;
      await db.azureDevOpsProject.updateMany({
        where: { installationId: ctx.installationId, id: projectId },
        data: done ? { backfillDone: true } : { backfillBefore: next },
      });
      if (done) break;
    }
  }
}

// ---------- timelines (z3) ----------

/**
 * Reads a build's timeline (and up to two previous-attempt timelines),
 * writes one row per record and attempt and derives maxAttempt, the
 * attempt-1 result, timed-out and the queue time.
 */
export async function syncTimeline(
  ctx: Pick<
    Ctx,
    "installationId" | "timezone" | "api" | "now" | "conn" | "result" | "days"
  >,
  build: {
    id: number;
    projectId: string;
    definitionId: number;
    repositoryId: bigint | null;
    queuedAt: Date;
    status: string;
    result: string;
  },
  osOverride: DefLink["osOverride"] = null,
): Promise<void> {
  const current = await ctx.api.getTimeline(build.projectId, build.id);
  if (!current) {
    await db.azureBuild.updateMany({
      where: { installationId: ctx.installationId, id: build.id },
      data: { timelineSyncedAt: ctx.now, dirtyAt: null },
    });
    return;
  }
  const rows: JobRow[] = mapTimeline(current.records, ctx.conn.maxJobMinutes);
  for (const prev of previousTimelines(current.records).slice(0, 2)) {
    const t = await ctx.api.getTimeline(
      build.projectId,
      build.id,
      prev.timelineId,
    );
    if (!t) continue;
    for (const r of mapTimeline(
      t.records,
      ctx.conn.maxJobMinutes,
      prev.attempt,
    )) {
      if (
        !rows.some((x) => x.recordId === r.recordId && x.attempt === r.attempt)
      )
        rows.push(r);
    }
  }
  const requests = new Map(
    (
      await db.azureJobRequest.findMany({
        where: {
          installationId: ctx.installationId,
          jobId: { in: rows.map((r) => r.recordId) },
        },
        select: {
          jobId: true,
          poolId: true,
          isHosted: true,
          os: true,
          hostedImage: true,
          queueTime: true,
          assignTime: true,
        },
      })
    ).map((r) => [r.jobId!, r]),
  );
  const status = build.status as Parameters<typeof deriveBuild>[0]["status"];
  const derived = deriveBuild(
    {
      result: build.result as Parameters<typeof deriveBuild>[0]["result"],
      status,
      queuedAt: build.queuedAt,
    },
    rows,
  );
  const data = rows.map((r) => {
    const req = requests.get(r.recordId);
    const os =
      r.type !== "Job"
        ? "UNKNOWN"
        : osOverride && osOverride !== "UNKNOWN"
          ? osOverride
          : req && req.os !== "UNKNOWN"
            ? req.os
            : r.os;
    const queueS =
      req?.queueTime && req.assignTime
        ? Math.max(
            0,
            Math.round(
              (req.assignTime.getTime() - req.queueTime.getTime()) / 1000,
            ),
          )
        : null;
    return {
      installationId: ctx.installationId,
      buildId: build.id,
      recordId: r.recordId,
      attempt: r.attempt,
      type: r.type,
      projectId: build.projectId,
      repositoryId: build.repositoryId,
      identifier: r.identifier,
      stageIdentifier: r.stageIdentifier,
      name: r.name,
      baseName: r.baseName,
      state: r.state,
      result: r.result,
      poolId: req?.poolId ?? null,
      isHosted: req ? req.isHosted : r.isHosted,
      hostedImage: req?.hostedImage ?? null,
      os: os as JobRow["os"],
      workerName: r.workerName,
      logId: r.logId,
      queuedAt: req?.queueTime ?? null,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationS: r.durationS,
      queueS,
      hitJobCap: r.hitJobCap,
    };
  });
  const firstQueue = data
    .filter((d) => d.type === "Job" && d.attempt === 1 && d.queueS != null)
    .sort(
      (a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0),
    )[0]?.queueS;
  await db.$transaction([
    db.azureBuildJob.deleteMany({
      where: { installationId: ctx.installationId, buildId: build.id },
    }),
    db.azureBuildJob.createMany({ data, skipDuplicates: true }),
    db.azureBuild.updateMany({
      where: { installationId: ctx.installationId, id: build.id },
      data: {
        maxAttempt: derived.maxAttempt,
        firstAttemptResult: derived.firstAttemptResult,
        timedOut: derived.timedOut,
        queueS: firstQueue ?? derived.queueS,
        timelineSyncedAt: ctx.now,
        timelineChangeId: current.changeId,
        dirtyAt: null,
      },
    }),
  ]);
  ctx.days.add(localDay(build.queuedAt, ctx.timezone));
  ctx.result.timelines++;
}

const timelineSelect = {
  id: true,
  projectId: true,
  definitionId: true,
  repositoryId: true,
  queuedAt: true,
  status: true,
  result: true,
} satisfies Prisma.AzureBuildSelect;

async function syncTimelines(
  ctx: Ctx,
  links: Map<string, DefLink>,
  limit: number,
): Promise<void> {
  const id = ctx.installationId;
  const picked = new Map<
    number,
    Prisma.AzureBuildGetPayload<{ select: typeof timelineSelect }>
  >();
  const add = (
    rows: Array<Prisma.AzureBuildGetPayload<{ select: typeof timelineSelect }>>,
  ) => {
    for (const r of rows)
      if (picked.size < limit && !picked.has(r.id)) picked.set(r.id, r);
  };
  add(
    await db.azureBuild.findMany({
      where: { installationId: id, dirtyAt: { not: null } },
      orderBy: { dirtyAt: "asc" },
      take: limit,
      select: timelineSelect,
    }),
  );
  add(
    await db.azureBuild.findMany({
      where: {
        installationId: id,
        status: { in: ["IN_PROGRESS", "CANCELLING"] },
        OR: [
          { timelineSyncedAt: null },
          {
            timelineSyncedAt: {
              lt: new Date(ctx.now.getTime() - OPEN_TIMELINE_EVERY_MS),
            },
          },
        ],
      },
      orderBy: { queuedAt: "desc" },
      take: limit,
      select: timelineSelect,
    }),
  );
  if (picked.size < limit) {
    const changed = await db.$queryRaw<Array<{ id: number }>>`
      SELECT "id" FROM "AzureBuild"
      WHERE "installationId" = ${id} AND "status" = 'COMPLETED'
        AND ("timelineSyncedAt" IS NULL OR "lastChangedAt" > "timelineSyncedAt")
      ORDER BY "queuedAt" DESC LIMIT ${limit}`;
    if (changed.length)
      add(
        await db.azureBuild.findMany({
          where: { installationId: id, id: { in: changed.map((c) => c.id) } },
          orderBy: { queuedAt: "desc" },
          select: timelineSelect,
        }),
      );
  }
  for (const b of picked.values()) {
    await syncTimeline(
      ctx,
      b,
      links.get(`${b.projectId}:${b.definitionId}`)?.osOverride ?? null,
    );
  }
}

// ---------- pools (z4) ----------

const MAX_POOLS = 6;

async function samplePools(ctx: Ctx): Promise<void> {
  const id = ctx.installationId;
  const pools = (await ctx.api.listPools()).filter(
    (p) => p.poolType === "automation",
  );
  const seen = pools.map((p) => p.id);
  for (const p of pools)
    await db.azurePool.upsert({
      where: { installationId_id: { installationId: id, id: p.id } },
      create: { installationId: id, ...p, sampledAt: ctx.now },
      update: { ...p, sampledAt: ctx.now, removedAt: null },
    });
  await db.azurePool.updateMany({
    where: { installationId: id, removedAt: null, id: { notIn: seen } },
    data: { removedAt: ctx.now },
  });
  const visibility = new Map(
    (
      await db.azureDevOpsProject.findMany({
        where: { installationId: id },
        select: { id: true, visibility: true },
      })
    ).map((p) => [p.id, p.visibility]),
  );
  // Hosted pools first (the free tier), then self-hosted ones.
  const ordered = [...pools]
    .sort((a, b) => Number(b.isHosted) - Number(a.isHosted))
    .slice(0, MAX_POOLS);
  let available = ctx.conn.jobRequestsAvailable ?? true;
  const newRequestDays: Date[] = [];
  for (const p of ordered) {
    let online: number | null = null;
    if (!p.isHosted) {
      const agents = await ctx.api.listAgents(p.id);
      online = agents.filter((a) => a.status === "online" && a.enabled).length;
      for (const a of agents)
        await db.azureAgent.upsert({
          where: {
            installationId_poolId_id: {
              installationId: id,
              poolId: p.id,
              id: a.id,
            },
          },
          create: {
            installationId: id,
            poolId: p.id,
            id: a.id,
            name: a.name,
            status: a.status,
            enabled: a.enabled,
            version: a.version,
            osDescription: a.osDescription,
            busy: a.busy,
            statusChangedAt: a.statusChangedAt,
            sampledAt: ctx.now,
          },
          update: {
            name: a.name,
            status: a.status,
            enabled: a.enabled,
            version: a.version,
            osDescription: a.osDescription,
            busy: a.busy,
            statusChangedAt: a.statusChangedAt,
            sampledAt: ctx.now,
          },
        });
      await db.azureAgent.deleteMany({
        where: {
          installationId: id,
          poolId: p.id,
          id: { notIn: agents.map((a) => a.id) },
        },
      });
    }
    let running = 0;
    let queued = 0;
    if (available) {
      try {
        const reqs = await ctx.api.listJobRequests(p.id);
        const oldest = ctx.now.getTime() - JOB_REQUEST_DAYS * DAY_MS;
        for (const r of reqs) {
          if (!r.queueTime || r.queueTime.getTime() < oldest) continue;
          if (!r.finishTime) {
            if (r.assignTime) running++;
            else queued++;
          }
          const vis = r.projectId ? visibility.get(r.projectId) : undefined;
          const row = {
            poolId: p.id,
            projectId: r.projectId,
            isHosted: p.isHosted,
            isPrivate: vis == null ? null : vis !== "public",
            os: p.isHosted ? osOf(r.image) : "UNKNOWN",
            hostedImage: r.image,
            queueTime: r.queueTime,
            assignTime: r.assignTime,
            finishTime: r.finishTime,
            jobId: r.jobId,
            buildId: r.buildId,
            result: r.result,
          } as const;
          await db.azureJobRequest.upsert({
            where: {
              installationId_requestId: {
                installationId: id,
                requestId: r.requestId,
              },
            },
            create: { installationId: id, requestId: r.requestId, ...row },
            update: row,
          });
          newRequestDays.push(r.assignTime ?? r.queueTime);
        }
      } catch (error) {
        if (
          error instanceof AzureError &&
          [
            "not_found",
            "forbidden",
            "bad_request",
            "unexpected_response",
          ].includes(error.code)
        ) {
          // The preview route is not available: estimate from builds (labelled partial).
          available = false;
        } else throw error;
      }
    }
    if (!available && p.isHosted) {
      running = await db.azureBuildJob.count({
        where: {
          installationId: id,
          type: "Job",
          state: "inProgress",
          isHosted: { not: false },
        },
      });
      queued = await db.azureBuild.count({
        where: {
          installationId: id,
          status: { in: ["NOT_STARTED", "POSTPONED"] },
        },
      });
    }
    await db.azurePoolSample.upsert({
      where: {
        installationId_poolId_at: {
          installationId: id,
          poolId: p.id,
          at: ctx.now,
        },
      },
      create: {
        installationId: id,
        poolId: p.id,
        at: ctx.now,
        running,
        queued,
        onlineAgents: online,
      },
      update: { running, queued, onlineAgents: online },
    });
  }
  // Job requests fill the queue time, OS and image of the synced jobs (jobId = record id; verify).
  await db.$executeRaw`
    UPDATE "AzureBuildJob" j SET
      "queueS" = GREATEST(0, EXTRACT(EPOCH FROM (r."assignTime" - r."queueTime"))::int),
      "queuedAt" = r."queueTime",
      "poolId" = r."poolId",
      "isHosted" = r."isHosted",
      "hostedImage" = COALESCE(r."hostedImage", j."hostedImage"),
      "os" = CASE WHEN j."os" = 'UNKNOWN' AND r."os" <> 'UNKNOWN' THEN r."os" ELSE j."os" END
    FROM "AzureJobRequest" r
    WHERE j."installationId" = ${id} AND r."installationId" = ${id}
      AND r."jobId" = j."recordId" AND r."assignTime" IS NOT NULL
      AND (j."queueS" IS NULL OR j."poolId" IS NULL)`;
  await db.azureDevOpsConnection.updateMany({
    where: { installationId: id },
    data: { poolsSampledAt: ctx.now, jobRequestsAvailable: available },
  });
  ctx.conn.jobRequestsAvailable = available;
  for (const d of usageDays(
    ctx.now,
    ctx.timezone,
    newRequestDays.slice(0, 2000),
  ))
    ctx.usageDays.add(d);
}

// ---------- usage (z5) and hooks (z6) ----------

async function syncUsage(ctx: Ctx): Promise<void> {
  const usage = await ctx.api.getResourceUsage();
  const id = ctx.installationId;
  if (usage) {
    const month = billingMonth(
      localDay(ctx.now, ctx.timezone),
      ctx.conn.monthResetDay,
    );
    const data = {
      usedMinutes: Math.round(usage.usedMinutes ?? 0),
      totalMinutes:
        usage.totalMinutes != null ? Math.round(usage.totalMinutes) : null,
      usedParallel: Math.round(usage.usedCount ?? 0),
      totalParallel: Math.round(
        usage.totalCount ?? ctx.conn.hostedParallelJobs,
      ),
      isPremium: usage.isPremium,
      capturedAt: ctx.now,
    };
    await db.azureUsageSnapshot.upsert({
      where: {
        installationId_month_source: {
          installationId: id,
          month: month.key,
          source: "api",
        },
      },
      create: { installationId: id, month: month.key, source: "api", ...data },
      update: data,
    });
    await db.azureDevOpsConnection.updateMany({
      where: { installationId: id },
      data: {
        detectedLimits: {
          totalMinutes: usage.totalMinutes,
          totalCount: usage.totalCount,
          isPremium: usage.isPremium,
        },
      },
    });
  }
  await db.azureDevOpsConnection.updateMany({
    where: { installationId: id },
    data: { usageSyncedAt: ctx.now },
  });
}

/** The public URL prefix of our service hooks. */
export function hookUrlPrefix(): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/api/azure/hooks/`;
}

async function checkHooks(ctx: Ctx): Promise<void> {
  const id = ctx.installationId;
  let subs;
  try {
    subs = await ctx.api.listHookSubscriptions();
  } catch (error) {
    // Without Service Hooks (Read) nothing is checked; polling still works.
    if (
      error instanceof AzureError &&
      (error.code === "forbidden" || error.code === "not_found")
    ) {
      await db.azureDevOpsConnection.updateMany({
        where: { installationId: id },
        data: { hooksCheckedAt: ctx.now },
      });
      return;
    }
    throw error;
  }
  const prefix = ctx.conn.hookKey
    ? `${hookUrlPrefix()}${ctx.conn.hookKey}`
    : null;
  const ours = prefix ? subs.filter((s) => s.url?.startsWith(prefix)) : [];
  for (const s of ours)
    await db.azureHookSubscription.upsert({
      where: { installationId_id: { installationId: id, id: s.id } },
      create: {
        installationId: id,
        id: s.id,
        eventType: s.eventType,
        projectId: s.projectId,
        status: s.status,
        checkedAt: ctx.now,
      },
      update: {
        eventType: s.eventType,
        projectId: s.projectId,
        status: s.status,
        checkedAt: ctx.now,
      },
    });
  await db.azureHookSubscription.deleteMany({
    where: { installationId: id, id: { notIn: ours.map((s) => s.id) } },
  });
  await db.azureDevOpsConnection.updateMany({
    where: { installationId: id },
    data: { hooksCheckedAt: ctx.now },
  });
}

// ---------- probable audit links ----------

/**
 * An ADO_QUEUE_RUN whose outcome is unknown and that no build names in a
 * tag is linked ("probable") to the build of the same definition, started
 * manually on the same branch within ±2 minutes. The audit row itself is
 * never rewritten.
 */
export async function linkProbableQueues(
  installationId: bigint,
  now: Date,
): Promise<number> {
  const rows = await db.auditLog.findMany({
    where: {
      installationId,
      action: "ADO_QUEUE_RUN",
      status: "FAILED",
      error: { startsWith: "outcome_unknown" },
      createdAt: { gte: new Date(now.getTime() - DAY_MS) },
    },
    take: 20,
    select: { id: true, createdAt: true, params: true },
  });
  let linked = 0;
  for (const r of rows) {
    const p = (r.params ?? {}) as Record<string, unknown>;
    if (typeof p.projectId !== "string" || typeof p.definitionId !== "number")
      continue;
    if (
      await db.azureBuild.findFirst({
        where: { installationId, auditLogId: r.id },
        select: { id: true },
      })
    )
      continue;
    const branch =
      typeof p.refName === "string"
        ? p.refName.replace(/^refs\/heads\//, "")
        : null;
    const b = await db.azureBuild.findFirst({
      where: {
        installationId,
        projectId: p.projectId,
        definitionId: p.definitionId,
        reason: "workflow_dispatch",
        auditLogId: null,
        ...(branch ? { headBranch: branch } : {}),
        queuedAt: {
          gte: new Date(r.createdAt.getTime() - PROBABLE_WINDOW_MS),
          lte: new Date(r.createdAt.getTime() + PROBABLE_WINDOW_MS),
        },
      },
      orderBy: { queuedAt: "asc" },
      select: { id: true },
    });
    if (!b) continue;
    await db.azureBuild.updateMany({
      where: { installationId, id: b.id, auditLogId: null },
      data: { auditLogId: r.id, auditLinkKind: "probable" },
    });
    linked++;
  }
  return linked;
}

// ---------- failures outside the step ----------

/**
 * The connection state a failed Azure DevOps call implies, for calls
 * outside the step (hint refreshes, actions, the log excerpt): a rejected
 * credential revokes the connection (plus the finding), a rate stop pauses
 * the sync (`pause: false` for writes). Returns whether it was one of these.
 */
export async function noteAzureFailure(
  installationId: bigint,
  error: unknown,
  now: Date,
  secrets: ReadonlyArray<string>,
  opts: { pause?: boolean } = {},
): Promise<boolean> {
  if (
    (error instanceof AzureError && error.revoked) ||
    (error instanceof EntraError && error.revoked)
  ) {
    await markAzureRevoked(
      installationId,
      `${error instanceof AzureError ? (error.status ?? "") : (error.status ?? "")} ${error.message}`.trim(),
      now,
      secrets,
    );
    await updateAzureCredentialFindings(installationId, now);
    return true;
  }
  if (
    error instanceof AzureError &&
    error.rateLimited &&
    opts.pause !== false
  ) {
    await db.azureDevOpsConnection.updateMany({
      where: { installationId },
      data: { pausedUntil: error.retryAt ?? new Date(now.getTime() + 60_000) },
    });
    return true;
  }
  return false;
}

// ---------- the step ----------

async function finish(
  installationId: bigint,
  result: AzureStepResult,
  now: Date,
  secrets: ReadonlyArray<string | null | undefined>,
  rate: AzureRateInfo | null,
  extra: Prisma.AzureDevOpsConnectionUpdateManyMutationInput = {},
): Promise<AzureStepResult> {
  const reason = result.reason ? scrubKnown(result.reason, secrets, 300) : null;
  result.reason = reason ?? undefined;
  await db.azureDevOpsConnection.updateMany({
    where: { installationId },
    data: {
      lastSyncStatus: result.status,
      lastSyncedAt: now,
      lastError: result.status === "ok" ? null : reason,
      ...extra,
    },
  });
  if (rate && rate.limit != null && rate.remaining != null) {
    const data = {
      limit: Math.round(rate.limit),
      remaining: Math.round(rate.remaining),
      resetAt: rate.resetAt ?? new Date(now.getTime() + 5 * 60_000),
      updatedAt: now,
    };
    await db.installationRateLimit.upsert({
      where: { installationId_resource: { installationId, resource: "azure" } },
      create: { installationId, resource: "azure", ...data },
      update: data,
    });
  }
  return result;
}

/** DB-only work after the calls: rollups, usage, findings, probable links. */
async function settle(ctx: Ctx): Promise<void> {
  await drainPipelineRollups(
    ctx.installationId,
    ctx.timezone,
    [...ctx.days],
    ctx.retentionDays,
    ctx.deadline,
  );
  if (ctx.usageDays.size > 0)
    await computeDailyUsage(
      ctx.installationId,
      ctx.timezone,
      [...ctx.usageDays],
      ctx.conn.hostedParallelJobs,
      ctx.conn.jobRequestsAvailable === false ? "builds" : "jobrequests",
    );
  await writeEstimateSnapshot(
    ctx.installationId,
    ctx.timezone,
    ctx.conn,
    ctx.now,
  );
  await updateAzureFindings(ctx.installationId, ctx.timezone, ctx.now);
  await linkProbableQueues(ctx.installationId, ctx.now);
}

/** Reconcile step z for one installation. Never throws for Azure DevOps errors. */
export async function runAzureStep(
  opts: AzureStepOptions,
): Promise<AzureStepResult> {
  const { installationId } = opts;
  const fast = opts.mode === "fast";
  const budgetMs =
    opts.budgetMs ?? (fast ? AZURE_FAST_BUDGET_MS : AZURE_STEP_BUDGET_MS);
  const deadline = stepDeadline(opts.deadline, budgetMs);
  const startedAt = deadline.now();
  const envCredential =
    opts.envCredential === undefined
      ? envAzureCredential()
      : opts.envCredential;
  const now = new Date(deadline.now());

  if (!fast && envCredential)
    await ensureAzureEnvConnection(
      installationId,
      envCredential,
      opts.fetch,
      now,
    ).catch((error: unknown) =>
      console.warn(
        "Azure DevOps env credential not applied",
        scrubKnown(
          error instanceof Error ? error.message : "unknown",
          [
            envCredential.kind === "pat"
              ? envCredential.pat
              : envCredential.clientSecret,
            envCredential.org,
          ],
          200,
        ),
      ),
    );

  const conn = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: CONN_SELECT,
  });
  if (!conn) return empty("none");
  if (conn.revokedAt) {
    await updateAzureCredentialFindings(installationId, now);
    return empty("credential_error");
  }
  if (conn.pausedUntil && conn.pausedUntil > now)
    return {
      ...empty("rate_limited"),
      reason: "paused until the Azure DevOps rate limit resets",
    };

  let cred;
  try {
    cred = await azureCredentialFor(installationId, {
      envCredential,
      fetch: opts.fetch,
      now: () => deadline.now(),
    });
  } catch (error) {
    if (error instanceof EntraError && error.revoked) {
      await markAzureRevoked(installationId, error.message, now, [
        conn.orgName,
      ]);
      await updateAzureCredentialFindings(installationId, now);
      return {
        ...empty("credential_error"),
        reason: "service principal secret rejected",
      };
    }
    return finish(
      installationId,
      {
        ...empty("error"),
        reason: error instanceof Error ? error.message : "credential error",
      },
      now,
      [conn.orgName],
      null,
    );
  }
  if (cred.kind === "env_missing")
    return {
      ...empty("credential_error"),
      reason: "the Azure DevOps env credential is not set",
    };
  if (cred.kind !== "token") {
    await updateAzureCredentialFindings(installationId, now);
    return empty(cred.kind === "none" ? "none" : "credential_error");
  }

  let rate: AzureRateInfo | null = null;
  const secrets = [...cred.secrets, conn.orgName];
  const result = empty("ok");
  const api = azureApiFor(cred.org, cred.auth, deadline, opts.fetch, {
    onRate: (r) => {
      if (r.limit != null || r.remaining != null) rate = r;
    },
    maxRequests: fast ? FAST_REQUEST_CAP : PASS_REQUEST_CAP,
  });
  const ctx: Ctx = {
    installationId,
    timezone: opts.timezone,
    api,
    deadline,
    now,
    conn,
    secrets,
    result,
    days: new Set(),
    usageDays: new Set(),
    retentionDays: opts.retentionDays,
  };
  const age = (d: Date | null) => (d ? now.getTime() - d.getTime() : Infinity);
  if (!fast)
    for (const d of usageDays(now, opts.timezone)) ctx.usageDays.add(d);

  try {
    if (
      opts.forceDefinitions ||
      (age(conn.definitionsSyncedAt) > DEFINITIONS_MAX_AGE_MS &&
        (!fast || !conn.definitionsSyncedAt))
    )
      await syncDefinitions(ctx);
    let links = await definitionLinks(installationId);
    await refreshOpenBuilds(ctx, links);
    await syncNewBuilds(ctx, links);
    if (!fast && age(conn.sweepAt) > SWEEP_EVERY_MS)
      await sweepFinished(ctx, links);
    await syncTimelines(ctx, links, fast ? 5 : TIMELINES_PER_PASS);
    if (!fast && age(conn.poolsSampledAt) > POOLS_MAX_AGE_MS)
      await samplePools(ctx);
    if (
      !fast &&
      (age(conn.usageSyncedAt) > USAGE_MAX_AGE_MS ||
        (opts.forceUsage && age(conn.usageSyncedAt) > 10 * 60_000))
    )
      await syncUsage(ctx);
    if (!fast && age(conn.hooksCheckedAt) > HOOKS_MAX_AGE_MS)
      await checkHooks(ctx);
    if (!fast) {
      // Backfill with what is left, at most half of the step's budget.
      links = await definitionLinks(installationId);
      await backfill(ctx, links, startedAt + budgetMs / 2);
    }
    if (api.transport.stoppedUntil)
      throw new AzureError(
        429,
        "rate_limited",
        "Azure DevOps asked to slow down",
        null,
        "",
        api.transport.stoppedUntil,
      );
  } catch (error) {
    result.requests = api.transport.requests;
    await settle(ctx).catch((e: unknown) =>
      console.warn(
        "Azure DevOps settle failed",
        scrubKnown(e instanceof Error ? e.message : "unknown", secrets, 200),
      ),
    );
    if (
      error instanceof DeadlineReached ||
      (error instanceof AzureError &&
        (error.code === "request_cap" ||
          (error.code === "timeout" && deadline.expired(REQUEST_RESERVE_MS))))
    ) {
      result.status = "partial";
      result.reason =
        error instanceof AzureError && error.code === "request_cap"
          ? "request cap of the pass (Azure DevOps step)"
          : "deadline (Azure DevOps step budget)";
      return finish(installationId, result, now, secrets, rate);
    }
    if (
      (error instanceof AzureError && error.revoked) ||
      (error instanceof EntraError && error.revoked)
    ) {
      await markAzureRevoked(
        installationId,
        `${error instanceof AzureError ? (error.status ?? "") : ""} ${error.message}`.trim(),
        now,
        secrets,
      );
      await updateAzureCredentialFindings(installationId, now);
      return {
        ...result,
        status: "credential_error",
        reason: "credential rejected by Azure DevOps",
      };
    }
    if (error instanceof AzureError && error.rateLimited) {
      result.status = "rate_limited";
      result.reason = `rate limited until ${error.retryAt?.toISOString() ?? "later"}`;
      return finish(installationId, result, now, secrets, rate, {
        pausedUntil: error.retryAt,
      });
    }
    result.status = "error";
    result.reason =
      error instanceof AzureError
        ? `${error.status ?? "network"} ${error.path}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return finish(installationId, result, now, secrets, rate);
  }
  result.requests = api.transport.requests;
  await settle(ctx);
  await updateAzureCredentialFindings(installationId, now);
  await touchAzureUse(installationId, now);
  return finish(installationId, result, now, secrets, rate, {
    pausedUntil: null,
  });
}

/**
 * z5 on its own (the Usage page, at most every 10 minutes; the caller
 * claimed the slot): resourceusage, the estimate snapshot and the minutes
 * finding, in 5 s.
 */
export async function refreshAzureUsageNow(
  installationId: bigint,
  opts: { fetch?: Fetch; now?: Date } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const conn = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: { ...CONN_SELECT, installation: { select: { timezone: true } } },
  });
  if (!conn || conn.revokedAt || (conn.pausedUntil && conn.pausedUntil > now))
    return;
  let secrets: string[] = [conn.orgName];
  try {
    const cred = await azureCredentialFor(installationId, {
      fetch: opts.fetch,
    });
    if (cred.kind !== "token") return;
    secrets = [...cred.secrets, conn.orgName];
    const deadline = new Deadline(now.getTime() + 5_000, Date.now);
    const ctx: Ctx = {
      installationId,
      timezone: conn.installation.timezone,
      api: azureApiFor(cred.org, cred.auth, deadline, opts.fetch, {
        maxRequests: 2,
      }),
      deadline,
      now,
      conn,
      secrets,
      result: empty("ok"),
      days: new Set(),
      usageDays: new Set(),
      retentionDays: null,
    };
    await syncUsage(ctx);
    await writeEstimateSnapshot(installationId, ctx.timezone, conn, now);
    await updateAzureFindings(installationId, ctx.timezone, now);
  } catch (error) {
    await noteAzureFailure(installationId, error, now, secrets);
  }
}
