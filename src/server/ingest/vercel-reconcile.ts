import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { localDay } from "@/server/metrics/days";
import {
  createVercelClient,
  vercelProjectUrl,
  VercelError,
  type Fetch,
  type VercelDeploymentInfo,
  type VercelProjectInfo,
  type VercelRateInfo,
  type VercelReadApi,
} from "@/server/vercel/client";
import { Deadline, DeadlineReached } from "./budget";
import {
  markVercelRevoked,
  touchVercelUse,
  vercelCredentialFor,
  type EnvVercelToken,
  envVercelToken,
} from "./vercel-credential";
import { ensureEnvConnection } from "./vercel-connect";
import { scrubKnown } from "./webhook";
import { compareCodeUnits } from "@/lib/compare";

/**
 * Reconcile step "v" (design addendum §7): the Vercel inventory of one
 * installation, read-only, bounded by its own budget (25 s; 20 s for the
 * lazy fast path) and resumable from cursors stored on the connection.
 *
 *   v1 projects      every 6 h, on Sync now, and after a production
 *                    deployment became ready (the live production id moves)
 *   v2 deployments   every pass: since the cursor minus 10 minutes (first
 *                    pass: the retention window), newest first; the cursor
 *                    advances only when the page chain completes
 *   v3 refresh       non-terminal deployments (newest 20) and projects a
 *                    GitHub deployment hint marked dirty; non-terminal after
 *                    6 h becomes UNKNOWN
 *   v4 latest prod   DB only: latest production state, live deployment,
 *                    "auto-assign paused" (rollback), and the findings
 *   v5 rollup        DailyDeploymentStat for the days touched
 *   v7 audit links   DB only: a deployment whose `meta.devopsManagerAudit`
 *                    names a VERCEL_REDEPLOY row of this installation is
 *                    linked to it ("exact", in the upsert); a redeploy whose
 *                    outcome is unknown is linked to the redeploy-created
 *                    deployment of its project within 2 minutes ("probable")
 *
 * Failure handling: 401 or 403 with invalidToken/missingToken revokes the
 * connection (no further calls until a rotate); a 429 pauses until its
 * retry time; every error text is scrubbed of the token.
 */

export const VERCEL_STEP_BUDGET_MS = 25_000;
export const VERCEL_FAST_BUDGET_MS = 20_000;
const REQUEST_RESERVE_MS = 2_000;
const PROJECTS_MAX_AGE_MS = 6 * 3_600_000;
const CURSOR_OVERLAP_MS = 10 * 60_000;
const NON_TERMINAL_MAX_MS = 6 * 3_600_000;
const REFRESH_MAX_CALLS = 20;
const DAY_MS = 86_400_000;
const TOKEN_EXPIRY_WARN_MS = 14 * DAY_MS;
const NON_TERMINAL = ["QUEUED", "INITIALIZING", "BUILDING"] as const;

export type VercelStepStatus =
  "none" | "ok" | "partial" | "rate_limited" | "credential_error" | "error";

export type VercelStepResult = {
  status: VercelStepStatus;
  reason?: string;
  projects: number;
  deployments: number;
  refreshed: number;
  requests: number;
};

export type VercelStepOptions = {
  installationId: bigint;
  timezone: string;
  /** Raw retention in days (null = unlimited, backfill then 90 days). */
  retentionDays: number | null;
  deadline: Deadline;
  /** "fast": the lazy path (v2, v3, v4, v5; v1 only when never synced). */
  mode?: "full" | "fast";
  /** Sync now: v1 runs regardless of its age. */
  forceProjects?: boolean;
  budgetMs?: number;
  fetch?: Fetch;
  envToken?: EnvVercelToken | null;
};

type Ctx = {
  installationId: bigint;
  timezone: string;
  api: VercelReadApi;
  deadline: Deadline;
  now: Date;
  token: string;
  days: Set<string>;
  result: VercelStepResult;
  rate: VercelRateInfo | null;
  prodBecameReady: boolean;
};

const empty = (status: VercelStepStatus): VercelStepResult => ({
  status,
  projects: 0,
  deployments: 0,
  refreshed: 0,
  requests: 0,
});

function stepDeadline(outer: Deadline, budgetMs: number): Deadline {
  return new Deadline(Math.min(outer.endsAt, outer.now() + budgetMs), () =>
    outer.now(),
  );
}

export function vercelApiFor(
  token: string,
  teamId: string,
  deadline: Deadline,
  fetchImpl: Fetch | undefined,
  hooks: { onRate?: (r: VercelRateInfo) => void; onRequest?: () => void } = {},
): VercelReadApi {
  return createVercelClient({
    token,
    teamId,
    fetch: fetchImpl,
    now: () => deadline.now(),
    timeoutMs: () => Math.min(10_000, deadline.remainingMs() - 1_000),
    beforeRequest: () => {
      if (deadline.expired(REQUEST_RESERVE_MS)) throw new DeadlineReached();
      hooks.onRequest?.();
    },
    onRate: hooks.onRate,
  });
}

// ---------- writes ----------

/** The repository a project link resolves to: same installation, active, not ignored. */
async function resolveRepository(
  installationId: bigint,
  repoId: bigint | null,
): Promise<bigint | null> {
  if (repoId === null) return null;
  const repo = await db.repository.findFirst({
    where: { id: repoId, installationId, removedAt: null, ignoredAt: null },
    select: { id: true },
  });
  return repo?.id ?? null;
}

export async function upsertProjects(
  installationId: bigint,
  projects: ReadonlyArray<VercelProjectInfo>,
  now: Date,
): Promise<void> {
  for (const p of projects) {
    // A project id that belongs to another installation's team is never
    // taken over (team ids are unique, so this only guards bad data).
    const existing = await db.vercelProject.findUnique({
      where: { id: p.id },
      select: { installationId: true },
    });
    if (existing && existing.installationId !== installationId) continue;
    const repositoryId = await resolveRepository(installationId, p.linkRepoId);
    const data = {
      name: p.name,
      framework: p.framework,
      linkType: p.linkType,
      linkRepoId: p.linkRepoId,
      linkRepo: p.linkRepo,
      productionBranch: p.productionBranch,
      repositoryId,
      liveProdDeploymentId: p.liveProductionId,
      pausedAt: p.paused ? now : null,
      projectReadAt: now,
      removedAt: null,
    };
    await db.vercelProject.upsert({
      where: { id: p.id },
      create: { id: p.id, installationId, ...data },
      update: data,
    });
  }
}

/** Makes sure every project a deployment names exists (v1 fills in the rest). */
async function ensureProjects(
  installationId: bigint,
  deployments: ReadonlyArray<VercelDeploymentInfo>,
): Promise<Set<string>> {
  const ids = [...new Set(deployments.map((d) => d.projectId))];
  const known = await db.vercelProject.findMany({
    where: { id: { in: ids } },
    select: { id: true, installationId: true },
  });
  const mine = new Set(
    known.filter((k) => k.installationId === installationId).map((k) => k.id),
  );
  const foreign = new Set(
    known.filter((k) => k.installationId !== installationId).map((k) => k.id),
  );
  const missing = ids.filter((id) => !mine.has(id) && !foreign.has(id));
  if (missing.length > 0) {
    await db.vercelProject.createMany({
      data: missing.map((id) => ({
        id,
        installationId,
        name:
          deployments.find((d) => d.projectId === id)?.projectName ??
          id.slice(0, 40),
      })),
      skipDuplicates: true,
    });
    // The new project's link and production branch come with the next v1.
    await db.vercelConnection.updateMany({
      where: { installationId },
      data: { projectsSyncedAt: null },
    });
    for (const id of missing) mine.add(id);
  }
  return mine;
}

export async function upsertDeployments(
  installationId: bigint,
  timezone: string,
  deployments: ReadonlyArray<VercelDeploymentInfo>,
  now: Date,
  days?: Set<string>,
): Promise<{ upserted: number; prodBecameReady: boolean }> {
  if (deployments.length === 0) return { upserted: 0, prodBecameReady: false };
  const mine = await ensureProjects(installationId, deployments);
  const rows = deployments.filter((d) => mine.has(d.projectId));
  const before = new Map(
    (
      await db.vercelDeployment.findMany({
        where: { id: { in: rows.map((d) => d.id) } },
        select: { id: true, state: true, installationId: true },
      })
    ).map((r) => [r.id, r]),
  );
  // v7 (exact): only redeploy rows of this installation can be named.
  const refs = [
    ...new Set(rows.map((d) => d.auditRef).filter((r): r is string => !!r)),
  ];
  const audits = new Set(
    refs.length > 0
      ? (
          await db.auditLog.findMany({
            where: {
              id: { in: refs },
              installationId,
              action: "VERCEL_REDEPLOY",
            },
            select: { id: true },
          })
        ).map((a) => a.id)
      : [],
  );
  let prodBecameReady = false;
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (const d of rows) {
    const prev = before.get(d.id);
    if (prev && prev.installationId !== installationId) continue;
    if (
      d.target === "production" &&
      d.state === "READY" &&
      prev?.state !== "READY"
    )
      prodBecameReady = true;
    const data = {
      projectId: d.projectId,
      target: d.target,
      state: d.state,
      readySubstate: d.readySubstate,
      url: d.url,
      branch: d.branch,
      commitSha: d.commitSha,
      commitMessage: d.commitMessage,
      creatorKind: d.creatorKind,
      errorCode: d.errorCode,
      isRollbackCandidate: d.isRollbackCandidate,
      createdAt: d.createdAt,
      buildingAt: d.buildingAt,
      readyAt: d.readyAt,
      buildMs: d.buildMs,
      syncedAt: now,
    };
    const link =
      d.auditRef && audits.has(d.auditRef)
        ? { auditLogId: d.auditRef, auditLinkKind: "exact" }
        : {};
    ops.push(
      db.vercelDeployment.upsert({
        where: { id: d.id },
        create: { id: d.id, installationId, ...data, ...link },
        update: { ...data, ...link },
      }),
    );
    days?.add(localDay(d.createdAt, timezone));
  }
  if (ops.length > 0) await db.$transaction(ops);
  return { upserted: ops.length, prodBecameReady };
}

// ---------- v1 ----------

async function syncProjects(ctx: Ctx): Promise<void> {
  const seen = new Set<string>();
  let from: string | number | null = null;
  for (let page = 0; page < 50; page++) {
    const res = await ctx.api.listProjects(from);
    ctx.result.requests++;
    await upsertProjects(ctx.installationId, res.projects, ctx.now);
    for (const p of res.projects) seen.add(p.id);
    ctx.result.projects += res.projects.length;
    if (!res.next || res.projects.length === 0) {
      // The chain is complete: projects not seen were deleted at Vercel.
      await db.vercelProject.updateMany({
        where: {
          installationId: ctx.installationId,
          removedAt: null,
          id: { notIn: [...seen] },
        },
        data: { removedAt: ctx.now },
      });
      await db.vercelConnection.updateMany({
        where: { installationId: ctx.installationId },
        data: { projectsSyncedAt: ctx.now },
      });
      return;
    }
    from = res.next;
  }
}

// ---------- v2 ----------

async function syncDeployments(
  ctx: Ctx,
  conn: {
    deploymentsCursor: bigint | null;
    deploymentsPageNext: bigint | null;
    deploymentsPassTop: bigint | null;
  },
  retentionDays: number | null,
): Promise<void> {
  const nowMs = ctx.now.getTime();
  const since =
    conn.deploymentsCursor != null
      ? Number(conn.deploymentsCursor) - CURSOR_OVERLAP_MS
      : nowMs - (retentionDays ?? 90) * DAY_MS;
  let until =
    conn.deploymentsPageNext != null ? Number(conn.deploymentsPageNext) : null;
  let top =
    conn.deploymentsPassTop != null ? Number(conn.deploymentsPassTop) : null;
  for (;;) {
    const page = await ctx.api.listDeployments({ since, until });
    ctx.result.requests++;
    const { upserted, prodBecameReady } = await upsertDeployments(
      ctx.installationId,
      ctx.timezone,
      page.deployments,
      ctx.now,
      ctx.days,
    );
    ctx.prodBecameReady ||= prodBecameReady;
    ctx.result.deployments += upserted;
    for (const d of page.deployments)
      top = Math.max(top ?? 0, d.createdAt.getTime());
    const done =
      page.next == null ||
      page.deployments.length === 0 ||
      page.next <= since ||
      (until != null && page.next >= until);
    if (done) {
      const cursor =
        top ??
        (conn.deploymentsCursor != null
          ? Number(conn.deploymentsCursor)
          : since);
      await db.vercelConnection.updateMany({
        where: { installationId: ctx.installationId },
        data: {
          deploymentsCursor: BigInt(Math.min(cursor, nowMs)),
          deploymentsPageNext: null,
          deploymentsPassTop: null,
        },
      });
      return;
    }
    until = page.next!;
    // Persist the resume point after every page, so a deadline loses nothing.
    await db.vercelConnection.updateMany({
      where: { installationId: ctx.installationId },
      data: {
        deploymentsPageNext: BigInt(until),
        deploymentsPassTop: top != null ? BigInt(top) : null,
      },
    });
  }
}

// ---------- v3 ----------

/** Re-reads one project's newest deployments (GitHub hints, dirty projects). */
export async function refreshProject(
  ctx: Pick<
    Ctx,
    "installationId" | "timezone" | "api" | "now" | "days" | "result"
  > & {
    prodBecameReady?: boolean;
  },
  projectId: string,
): Promise<boolean> {
  const page = await ctx.api.listDeployments({ projectId, limit: 10 });
  ctx.result.requests++;
  const { upserted, prodBecameReady } = await upsertDeployments(
    ctx.installationId,
    ctx.timezone,
    page.deployments,
    ctx.now,
    ctx.days,
  );
  ctx.result.refreshed += upserted;
  await db.vercelProject.updateMany({
    where: { id: projectId, installationId: ctx.installationId },
    data: { dirtyAt: null },
  });
  return prodBecameReady;
}

async function refreshOpen(ctx: Ctx): Promise<void> {
  let calls = 0;
  const dirty = await db.vercelProject.findMany({
    where: {
      installationId: ctx.installationId,
      dirtyAt: { not: null },
      removedAt: null,
    },
    orderBy: { dirtyAt: "desc" },
    take: REFRESH_MAX_CALLS,
    select: { id: true },
  });
  for (const p of dirty) {
    if (calls >= REFRESH_MAX_CALLS) break;
    calls++;
    ctx.prodBecameReady ||= await refreshProject(ctx, p.id);
  }
  const open = await db.vercelDeployment.findMany({
    where: {
      installationId: ctx.installationId,
      state: { in: [...NON_TERMINAL] },
    },
    orderBy: { createdAt: "desc" },
    take: REFRESH_MAX_CALLS,
    select: { id: true, createdAt: true },
  });
  for (const d of open) {
    if (calls >= REFRESH_MAX_CALLS) break;
    calls++;
    try {
      const fresh = await ctx.api.getDeployment(d.id);
      ctx.result.requests++;
      if (fresh) {
        const r = await upsertDeployments(
          ctx.installationId,
          ctx.timezone,
          [fresh],
          ctx.now,
          ctx.days,
        );
        ctx.prodBecameReady ||= r.prodBecameReady;
        ctx.result.refreshed += r.upserted;
      }
    } catch (error) {
      if (error instanceof VercelError && error.status === 404) {
        ctx.result.requests++;
        await db.vercelDeployment.updateMany({
          where: { id: d.id, installationId: ctx.installationId },
          data: { state: "DELETED", syncedAt: ctx.now },
        });
        continue;
      }
      throw error;
    }
  }
  // Still building after 6 h: Vercel would have ended it; show "unknown".
  await db.vercelDeployment.updateMany({
    where: {
      installationId: ctx.installationId,
      state: { in: [...NON_TERMINAL] },
      createdAt: { lt: new Date(ctx.now.getTime() - NON_TERMINAL_MAX_MS) },
    },
    data: { state: "UNKNOWN" },
  });
}

// ---------- v4 ----------

type FindingInput = {
  source: "VERCEL" | "CREDENTIAL";
  ruleKey: string;
  repositoryId: bigint | null;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  title: string;
  externalUrl: string | null;
  details: Record<string, string | number | boolean | null>;
};

/** Opens or refreshes a finding (ruleKey is stable). */
export async function raiseFinding(
  installationId: bigint,
  f: FindingInput,
  now: Date,
): Promise<void> {
  const existing = await db.finding.findFirst({
    where: {
      installationId,
      source: f.source,
      ruleKey: f.ruleKey,
      repositoryId: f.repositoryId,
    },
    select: { id: true, status: true },
  });
  const data = {
    severity: f.severity,
    title: f.title.slice(0, 200),
    externalUrl: f.externalUrl,
    details: f.details,
    lastSeenAt: now,
  };
  if (!existing) {
    await db.finding.create({
      data: {
        installationId,
        source: f.source,
        ruleKey: f.ruleKey,
        repositoryId: f.repositoryId,
        status: "OPEN",
        firstSeenAt: now,
        ...data,
      },
    });
    return;
  }
  await db.finding.update({
    where: { id: existing.id },
    data: {
      ...data,
      // A dismissed finding stays dismissed; a fixed one opens again.
      ...(existing.status === "FIXED"
        ? { status: "OPEN", firstSeenAt: now, resolvedAt: null }
        : {}),
    },
  });
}

/** Marks open findings with these rule-key prefixes fixed, except `keep`. */
export async function resolveFindings(
  installationId: bigint,
  source: "VERCEL" | "CREDENTIAL",
  prefix: string,
  keep: ReadonlyArray<string>,
  now: Date,
): Promise<void> {
  await db.finding.updateMany({
    where: {
      installationId,
      source,
      status: "OPEN",
      ruleKey: { startsWith: prefix, notIn: [...keep] },
    },
    data: { status: "FIXED", resolvedAt: now },
  });
}

function latestOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** v4: denormalises the production state per project and writes the findings. */
export async function updateLatestProduction(
  installationId: bigint,
  now: Date,
): Promise<void> {
  const conn = await db.vercelConnection.findUnique({
    where: { installationId },
    select: { teamSlug: true, projectsSyncedAt: true },
  });
  if (!conn) return;
  const projects = await db.vercelProject.findMany({
    where: { installationId, removedAt: null },
    select: {
      id: true,
      name: true,
      repositoryId: true,
      manualRepositoryId: true,
      liveProdDeploymentId: true,
      autoAssignPausedAt: true,
      aliasRequestType: true,
      aliasRequestAt: true,
      projectReadAt: true,
    },
  });
  const failing: string[] = [];
  const paused: string[] = [];
  for (const p of projects) {
    const [latest, newestReady, live] = await Promise.all([
      db.vercelDeployment.findFirst({
        where: { installationId, projectId: p.id, target: "production" },
        orderBy: { createdAt: "desc" },
        select: { id: true, state: true, readyAt: true },
      }),
      db.vercelDeployment.findFirst({
        where: {
          installationId,
          projectId: p.id,
          target: "production",
          state: "READY",
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true, readyAt: true },
      }),
      p.liveProdDeploymentId
        ? db.vercelDeployment.findFirst({
            where: { installationId, id: p.liveProdDeploymentId },
            select: { id: true, createdAt: true },
          })
        : Promise.resolve(null),
    ]);
    // Production is pinned to an older deployment (a rollback) when the
    // project's live deployment is older than the newest ready production
    // deployment and the project was read (v1 list or a targeted re-read
    // after a hint) after that one became ready.
    // A promote re-enables auto-assignment even for an older deployment,
    // so a pin older than the last promote read after an action is not a
    // pause. A rollback read after an action pauses it until the project
    // list is read again (the rollback job may still be running then).
    const promotedAfter =
      p.aliasRequestType === "promote" &&
      !!p.aliasRequestAt &&
      !!newestReady &&
      newestReady.createdAt <= p.aliasRequestAt;
    const readAt = latestOf(conn.projectsSyncedAt, p.projectReadAt);
    const rolledBack =
      p.aliasRequestType === "rollback" &&
      !!p.aliasRequestAt &&
      (!readAt || readAt <= p.aliasRequestAt);
    const pinned =
      rolledBack ||
      (!promotedAfter &&
        !!live &&
        !!newestReady &&
        live.id !== newestReady.id &&
        live.createdAt < newestReady.createdAt &&
        !!readAt &&
        !!newestReady.readyAt &&
        readAt > newestReady.readyAt);
    await db.vercelProject.update({
      where: { id: p.id },
      data: {
        latestProdDeploymentId: latest?.id ?? null,
        latestProdState: latest?.state ?? null,
        latestProdReadyAt: latest?.readyAt ?? null,
        autoAssignPausedAt: pinned ? (p.autoAssignPausedAt ?? now) : null,
      },
    });
    const repositoryId = p.manualRepositoryId ?? p.repositoryId;
    const url = vercelProjectUrl(conn.teamSlug, p.name);
    if (latest?.state === "ERROR") {
      const ruleKey = `vercel:prod-failing:${p.id}`;
      failing.push(ruleKey);
      await raiseFinding(
        installationId,
        {
          source: "VERCEL",
          ruleKey,
          repositoryId: null,
          severity: "HIGH",
          title: `${p.name}: production deployment failed`,
          externalUrl: url,
          details: {
            kind: "prod_failing",
            projectId: p.id,
            projectName: p.name,
            deploymentId: latest.id,
            repositoryId: repositoryId != null ? String(repositoryId) : null,
          },
        },
        now,
      );
    }
    if (pinned) {
      const ruleKey = `vercel:auto-assign-paused:${p.id}`;
      paused.push(ruleKey);
      await raiseFinding(
        installationId,
        {
          source: "VERCEL",
          ruleKey,
          repositoryId: null,
          severity: "MEDIUM",
          title: `${p.name}: production auto-assignment paused`,
          externalUrl: url,
          details: {
            kind: "auto_assign_paused",
            projectId: p.id,
            projectName: p.name,
            since: (p.autoAssignPausedAt ?? now).toISOString(),
            promoteDeploymentId:
              newestReady && newestReady.id !== live?.id
                ? newestReady.id
                : null,
            repositoryId: repositoryId != null ? String(repositoryId) : null,
          },
        },
        now,
      );
    }
  }
  await resolveFindings(
    installationId,
    "VERCEL",
    "vercel:prod-failing:",
    failing,
    now,
  );
  await resolveFindings(
    installationId,
    "VERCEL",
    "vercel:auto-assign-paused:",
    paused,
    now,
  );
}

/** Credential findings: token expiring within 14 days, or revoked. */
export async function updateCredentialFindings(
  installationId: bigint,
  now: Date,
): Promise<void> {
  const conn = await db.vercelConnection.findUnique({
    where: { installationId },
    select: {
      teamSlug: true,
      tokenExpiresAt: true,
      revokedAt: true,
      tokenSource: true,
    },
  });
  const keep: string[] = [];
  if (conn?.revokedAt) {
    keep.push("vercel:credential-revoked");
    await raiseFinding(
      installationId,
      {
        source: "CREDENTIAL",
        ruleKey: "vercel:credential-revoked",
        repositoryId: null,
        severity: "HIGH",
        title: "Vercel token rejected; reconnect required",
        externalUrl: null,
        details: {
          kind: "credential_revoked",
          since: conn.revokedAt.toISOString(),
        },
      },
      now,
    );
  } else if (
    conn?.tokenExpiresAt &&
    conn.tokenExpiresAt.getTime() - now.getTime() < TOKEN_EXPIRY_WARN_MS
  ) {
    keep.push("vercel:token-expiring");
    await raiseFinding(
      installationId,
      {
        source: "CREDENTIAL",
        ruleKey: "vercel:token-expiring",
        repositoryId: null,
        severity: conn.tokenExpiresAt <= now ? "HIGH" : "MEDIUM",
        title: "Vercel token expires soon",
        externalUrl: null,
        details: {
          kind: "token_expiring",
          expiresAt: conn.tokenExpiresAt.toISOString(),
        },
      },
      now,
    );
  }
  await resolveFindings(installationId, "CREDENTIAL", "vercel:", keep, now);
}

// ---------- v7 ----------

const PROBABLE_WINDOW_MS = 2 * 60_000;
const PROBABLE_LOOKBACK_MS = 24 * 3_600_000;

/**
 * v7 (probable): a VERCEL_REDEPLOY whose outcome is unknown (the request
 * failed after it was sent) and that no deployment names in its meta is
 * linked to the newest unlinked redeploy-created deployment of its project
 * created within 2 minutes after the audit row. The audit row itself is
 * never rewritten; the UI shows the link as "probably".
 */
export async function linkProbableRedeploys(
  installationId: bigint,
  now: Date,
): Promise<number> {
  const rows = await db.auditLog.findMany({
    where: {
      installationId,
      action: "VERCEL_REDEPLOY",
      status: "FAILED",
      error: { startsWith: "outcome_unknown" },
      createdAt: { gte: new Date(now.getTime() - PROBABLE_LOOKBACK_MS) },
    },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true, createdAt: true, params: true },
  });
  let linked = 0;
  for (const r of rows) {
    const params = (r.params ?? {}) as Record<string, unknown>;
    const projectId =
      typeof params.projectId === "string" ? params.projectId : null;
    if (!projectId) continue;
    const already = await db.vercelDeployment.findFirst({
      where: { installationId, auditLogId: r.id },
      select: { id: true },
    });
    if (already) continue;
    const d = await db.vercelDeployment.findFirst({
      where: {
        installationId,
        projectId,
        creatorKind: "redeploy",
        auditLogId: null,
        createdAt: {
          gte: new Date(r.createdAt.getTime() - 5_000),
          lte: new Date(r.createdAt.getTime() + PROBABLE_WINDOW_MS),
        },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!d) continue;
    await db.vercelDeployment.updateMany({
      where: { id: d.id, installationId, auditLogId: null },
      data: { auditLogId: r.id, auditLinkKind: "probable" },
    });
    linked++;
  }
  return linked;
}

/**
 * After an M6 promote or rollback: the project as Vercel reports it now
 * (serving deployment and the last alias request). A rollback pauses
 * production auto-assignment, a promote ends the pause (design addendum
 * §8.2, W4). The findings follow in the same call.
 */
export async function applyProjectAliasRead(
  installationId: bigint,
  project: VercelProjectInfo,
  action: "promote" | "rollback",
  now: Date,
): Promise<void> {
  const alias = project.aliasRequest;
  const current = await db.vercelProject.findFirst({
    where: { id: project.id, installationId },
    select: { autoAssignPausedAt: true },
  });
  if (!current) return;
  await db.vercelProject.updateMany({
    where: { id: project.id, installationId },
    data: {
      liveProdDeploymentId: project.liveProductionId,
      aliasRequestType: alias?.type ?? action,
      aliasRequestStatus: alias?.status ?? null,
      aliasRequestAt: alias?.at ?? now,
      aliasToDeploymentId: alias?.toDeploymentId ?? null,
      autoAssignPausedAt:
        action === "rollback" ? (current.autoAssignPausedAt ?? now) : null,
    },
  });
  await updateLatestProduction(installationId, now);
}

/**
 * After an M6 promote or rollback whose POST Vercel accepted but whose
 * re-read of the project failed: record the request locally (a rollback
 * pauses auto-assignment, a promote ends the pause) and mark the project
 * dirty. The serving deployment is not guessed; the next project read
 * brings it.
 */
export async function applyAliasActionLocally(
  installationId: bigint,
  projectId: string,
  action: "promote" | "rollback",
  toDeploymentId: string,
  now: Date,
): Promise<void> {
  const current = await db.vercelProject.findFirst({
    where: { id: projectId, installationId },
    select: { autoAssignPausedAt: true },
  });
  if (!current) return;
  await db.vercelProject.updateMany({
    where: { id: projectId, installationId },
    data: {
      aliasRequestType: action,
      aliasRequestStatus: null,
      aliasRequestAt: now,
      aliasToDeploymentId: toDeploymentId,
      autoAssignPausedAt:
        action === "rollback" ? (current.autoAssignPausedAt ?? now) : null,
      dirtyAt: now,
    },
  });
  await updateLatestProduction(installationId, now);
}

/**
 * The connection state a failed Vercel call implies, for calls outside the
 * reconcile step (hint refreshes, actions, the build log): a rejected token
 * revokes the connection (plus the finding), a 429 pauses the sync until
 * its retry time (`pause: false` for writes, whose limits are per action).
 * Returns whether the error was one of these.
 */
export async function noteVercelFailure(
  installationId: bigint,
  error: unknown,
  now: Date,
  token: string | undefined,
  opts: { pause?: boolean } = {},
): Promise<boolean> {
  if (!(error instanceof VercelError)) return false;
  if (error.revoked) {
    await markVercelRevoked(
      installationId,
      `${error.status ?? ""} ${error.message}`.trim(),
      now,
      token,
    );
    await updateCredentialFindings(installationId, now);
    return true;
  }
  if (error.rateLimited && opts.pause !== false) {
    await db.vercelConnection.updateMany({
      where: { installationId },
      data: {
        pausedUntil: error.retryAt ?? new Date(now.getTime() + 60_000),
      },
    });
    return true;
  }
  return false;
}

// ---------- v5 ----------

/** Recomputes DailyDeploymentStat for the given local days (DELETE + INSERT). */
export async function rollupDeploymentDays(
  installationId: bigint,
  timezone: string,
  days: ReadonlyArray<string>,
): Promise<void> {
  if (days.length === 0) return;
  const list = [...new Set(days)].sort(compareCodeUnits);
  await db.$transaction([
    db.$executeRaw`
      DELETE FROM "DailyDeploymentStat"
      WHERE "installationId" = ${installationId} AND "day" = ANY(${list}::date[])`,
    db.$executeRaw`
      INSERT INTO "DailyDeploymentStat"
        ("installationId", "projectId", "day", "target", "total", "ready", "error", "canceled", "buildMsP50", "buildMsP90")
      SELECT d."installationId", d."projectId",
             (d."createdAt" AT TIME ZONE ${timezone})::date AS day,
             d."target",
             count(*)::int,
             count(*) FILTER (WHERE d."state" = 'READY')::int,
             count(*) FILTER (WHERE d."state" = 'ERROR')::int,
             count(*) FILTER (WHERE d."state" = 'CANCELED')::int,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY d."buildMs") FILTER (WHERE d."buildMs" IS NOT NULL))::int,
             (percentile_cont(0.9) WITHIN GROUP (ORDER BY d."buildMs") FILTER (WHERE d."buildMs" IS NOT NULL))::int
      FROM "VercelDeployment" d
      WHERE d."installationId" = ${installationId}
        AND (d."createdAt" AT TIME ZONE ${timezone})::date = ANY(${list}::date[])
      GROUP BY 1, 2, 3, 4`,
  ]);
}

// ---------- the step ----------

async function finish(
  installationId: bigint,
  result: VercelStepResult,
  now: Date,
  token: string | null,
  rate: VercelRateInfo | null,
  extra: Prisma.VercelConnectionUpdateManyMutationInput = {},
): Promise<VercelStepResult> {
  const reason = result.reason ? scrubKnown(result.reason, [token], 300) : null;
  result.reason = reason ?? undefined;
  await db.vercelConnection.updateMany({
    where: { installationId },
    data: {
      lastSyncStatus: result.status,
      lastSyncedAt: now,
      lastError: result.status === "ok" ? null : reason,
      ...extra,
    },
  });
  if (rate) {
    const data = {
      limit: rate.limit,
      remaining: rate.remaining,
      resetAt: rate.resetAt,
      updatedAt: now,
    };
    await db.installationRateLimit.upsert({
      where: {
        installationId_resource: { installationId, resource: "vercel" },
      },
      create: { installationId, resource: "vercel", ...data },
      update: data,
    });
  }
  return result;
}

/** Reconcile step v for one installation. Never throws for Vercel errors. */
export async function runVercelStep(
  opts: VercelStepOptions,
): Promise<VercelStepResult> {
  const { installationId } = opts;
  const deadline = stepDeadline(
    opts.deadline,
    opts.budgetMs ??
      (opts.mode === "fast" ? VERCEL_FAST_BUDGET_MS : VERCEL_STEP_BUDGET_MS),
  );
  const envToken =
    opts.envToken === undefined ? envVercelToken() : opts.envToken;
  const now = new Date(deadline.now());

  if (opts.mode !== "fast" && envToken)
    await ensureEnvConnection(installationId, envToken, opts.fetch, now).catch(
      (error: unknown) => {
        console.warn(
          "Vercel env token not applied",
          scrubKnown(
            error instanceof Error ? error.message : "unknown",
            [envToken.token],
            200,
          ),
        );
      },
    );

  const conn = await db.vercelConnection.findUnique({
    where: { installationId },
    select: {
      teamId: true,
      revokedAt: true,
      pausedUntil: true,
      projectsSyncedAt: true,
      lastSyncedAt: true,
      deploymentsCursor: true,
      deploymentsPageNext: true,
      deploymentsPassTop: true,
    },
  });
  if (!conn) return empty("none");

  if (conn.revokedAt) {
    await updateCredentialFindings(installationId, now);
    return empty("credential_error");
  }
  if (conn.pausedUntil && conn.pausedUntil > now)
    return {
      ...empty("rate_limited"),
      reason: "paused until the Vercel rate limit resets",
    };

  const cred = await vercelCredentialFor(installationId, envToken);
  if (cred.kind === "env_missing") {
    // The env shortcut is configured on the connection but VERCEL_TOKEN is
    // gone: nothing to call; the settings page says so.
    return { ...empty("credential_error"), reason: "VERCEL_TOKEN is not set" };
  }
  if (cred.kind !== "token") {
    await updateCredentialFindings(installationId, now);
    return empty(cred.kind === "none" ? "none" : "credential_error");
  }

  let rate: VercelRateInfo | null = null;
  const result = empty("ok");
  const ctx: Ctx = {
    installationId,
    timezone: opts.timezone,
    api: vercelApiFor(cred.token, cred.teamId, deadline, opts.fetch, {
      onRate: (r) => (rate = r),
    }),
    deadline,
    now,
    token: cred.token,
    days: new Set(),
    result,
    rate: null,
    prodBecameReady: false,
  };

  const projectsStale =
    !conn.projectsSyncedAt ||
    now.getTime() - conn.projectsSyncedAt.getTime() > PROJECTS_MAX_AGE_MS;
  try {
    if (
      opts.forceProjects ||
      (projectsStale && (opts.mode !== "fast" || !conn.projectsSyncedAt))
    )
      await syncProjects(ctx);
    await syncDeployments(ctx, conn, opts.retentionDays);
    await refreshOpen(ctx);
    if (ctx.prodBecameReady && !opts.forceProjects) await syncProjects(ctx);
  } catch (error) {
    await rollupDeploymentDays(installationId, opts.timezone, [...ctx.days]);
    if (
      error instanceof DeadlineReached ||
      (error instanceof VercelError &&
        error.code === "timeout" &&
        deadline.expired(REQUEST_RESERVE_MS))
    ) {
      result.status = "partial";
      result.reason = "deadline (Vercel step budget)";
      await updateLatestProduction(installationId, now);
      await linkProbableRedeploys(installationId, now);
      return finish(installationId, result, now, cred.token, rate);
    }
    if (error instanceof VercelError && error.revoked) {
      await markVercelRevoked(
        installationId,
        `${error.status ?? ""} ${error.message}`.trim(),
        now,
        cred.token,
      );
      await updateCredentialFindings(installationId, now);
      return {
        ...result,
        status: "credential_error",
        reason: "token rejected by Vercel",
      };
    }
    if (error instanceof VercelError && error.rateLimited) {
      result.status = "rate_limited";
      result.reason = `rate limited until ${error.retryAt?.toISOString() ?? "later"}`;
      return finish(installationId, result, now, cred.token, rate, {
        pausedUntil: error.retryAt,
      });
    }
    result.status = "error";
    result.reason =
      error instanceof VercelError
        ? `${error.status ?? "network"} ${error.path}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return finish(installationId, result, now, cred.token, rate);
  }

  await rollupDeploymentDays(installationId, opts.timezone, [...ctx.days]);
  await updateLatestProduction(installationId, now);
  await linkProbableRedeploys(installationId, now);
  await updateCredentialFindings(installationId, now);
  await touchVercelUse(installationId, now);
  return finish(installationId, result, now, cred.token, rate, {
    pausedUntil: null,
  });
}
