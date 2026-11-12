import "server-only";
import { Prisma, type RunnerKind } from "@/generated/prisma/client";
import type { TenantScope } from "@/server/authz/scope";
import { db } from "@/server/db";
import {
  jobRunnerKeyResolver,
  runnerStatKey,
  type RunnerScopeRow,
} from "@/server/metrics/classify";
import { localDay } from "@/server/metrics/days";
import {
  histogramOf,
  histogramPercentile,
  mergeHistograms,
} from "@/server/metrics/histogram";
import {
  busySeconds,
  compareHostedSelfHosted,
  concurrencyTimeline,
  isInfraFailure,
  jobInterval,
  labelsSatisfy,
  medianSampleInterval,
  onlineSeconds,
  peakConcurrency,
  queueFlags,
  speedIndex,
  utilisation,
  type ConcurrencyBucket,
  type Interval,
  type QueueRunner,
  type SampleRow,
  type Utilisation,
} from "@/server/metrics/runners";
import { percentileExact, type Conclusion } from "@/server/metrics/stats";
import { rangeStart, visibleInstallation, type InsightRange } from "./insights";
import { NotFoundError } from "./installations";

/**
 * Runner and queue data for the UI (design §6.5, §7 /runners, /queue).
 * Every function takes a `TenantScope` and an installation id; an
 * installation outside the scope, or a runner of another installation,
 * throws `NotFoundError` (404) before any data is read. DTOs carry ids as
 * strings and times as ISO strings.
 */

const DAY_MS = 86_400_000;
const UTILISATION_WINDOW_MS = 7 * DAY_MS;
const MAX_JOB_ROWS = 100_000;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const num = (v: number | bigint | null | undefined) =>
  v == null ? null : Number(v);

type JobRow = {
  id: bigint;
  repositoryId: bigint;
  workflowId: bigint | null;
  workflowName: string;
  baseName: string;
  labels: string[];
  labelKey: string;
  runnerName: string | null;
  runnerKind: RunnerKind;
  conclusion: Conclusion | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  waitingS: number;
  durationS: number | null;
  queueS: number | null;
  billableMinEst: number | null;
};

/** Jobs that ran (or queued) inside [from, to), skipped jobs excluded. */
async function jobsIn(
  installationId: bigint,
  from: Date,
  to: Date,
  extra: Prisma.Sql = Prisma.empty,
): Promise<JobRow[]> {
  return db.$queryRaw<JobRow[]>`
    SELECT j."id", j."repositoryId", j."workflowId", j."workflowName", j."baseName", j."labels",
      j."labelKey", j."runnerName", j."runnerKind", j."conclusion"::text AS conclusion,
      j."createdAt", j."startedAt", j."completedAt", j."waitingS", j."durationS", j."queueS",
      j."billableMinEst"
    FROM "WorkflowJob" j
    WHERE j."installationId" = ${installationId}
      AND j."createdAt" < ${to}
      AND (j."completedAt" IS NULL OR j."completedAt" > ${from})
      AND j."createdAt" > ${new Date(from.getTime() - 5 * DAY_MS)}
      AND j."conclusion" IS DISTINCT FROM 'SKIPPED'
      AND NOT (j."runnerName" IS NULL AND j."startedAt" IS NOT NULL AND j."startedAt" = j."completedAt")
      ${extra}
    ORDER BY j."createdAt" ASC
    LIMIT ${MAX_JOB_ROWS}`;
}

type KeyOf = (j: JobRow) => string;

/**
 * The runner key of every job ("sh:<name>", "shr:<repositoryId>:<name>" for
 * repo runners, "pool:<labelKey>"), from all cached runners of the
 * installation, removed ones included: repo runner names are unique per
 * repository only, so jobs are matched by repository and name.
 */
async function jobKeyResolver(installationId: bigint): Promise<KeyOf> {
  const rows = await db.runner.findMany({
    where: { installationId },
    select: { scope: true, repositoryId: true, name: true },
  });
  return jobRunnerKeyResolver(rows);
}

async function samplesOf(
  installationId: bigint,
  runnerKeys: string[],
  from: Date,
  to: Date,
): Promise<Map<string, SampleRow[]>> {
  const out = new Map<string, SampleRow[]>();
  if (runnerKeys.length === 0) return out;
  const rows = await db.runnerSample.findMany({
    where: {
      installationId,
      runnerKey: { in: runnerKeys },
      sampledAt: { gt: from, lte: new Date(to.getTime() + DAY_MS) },
    },
    orderBy: { sampledAt: "asc" },
  });
  for (const r of rows) {
    const list = out.get(r.runnerKey) ?? [];
    list.push(r);
    out.set(r.runnerKey, list);
  }
  return out;
}

export type UtilisationDto = Utilisation & {
  /** Median sample interval: the "± one sample interval" shown with the value. */
  medianSampleIntervalS: number | null;
};

export type RunnerDto = {
  key: string;
  scope: "ORG" | "REPO";
  repository: { id: string; fullName: string } | null;
  githubRunnerId: string;
  name: string;
  os: string;
  labels: string[];
  groupName: string | null;
  online: boolean;
  busy: boolean;
  ephemeral: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  lastOnlineAt: string | null;
  jobs7d: number;
  failures7d: number;
  infraFailures7d: number;
  utilisation7d: UtilisationDto;
  speedIndex7d: number | null;
};

export type RunnerList = {
  runners: RunnerDto[];
  /** Repo runners need repository Administration: read; without it they come from job data only. */
  repoRunnersGranted: boolean;
  /** Org runners need Organization Self-hosted runners: read (org installations). */
  orgRunnersGranted: boolean;
  isOrganization: boolean;
  sampledAt: string | null;
  discoveredAt: string | null;
};

const granted = (perms: unknown, name: string) => {
  const v = (perms as Record<string, unknown> | null)?.[name];
  return v === "read" || v === "write";
};

async function installationMeta(installationId: bigint) {
  return db.installation.findUniqueOrThrow({
    where: { id: installationId },
    select: {
      accountType: true,
      permissions: true,
      runnersSampledAt: true,
      runnersDiscoveredAt: true,
    },
  });
}

/** Utilisation, infra failures and speed index of every listed runner over `w`. */
function runnerMetrics(
  runner: RunnerScopeRow & { key: string; removedAt: Date | null },
  jobs: JobRow[],
  keyOf: KeyOf,
  samples: SampleRow[],
  allJobs: ReadonlyArray<{
    workflowId: bigint | null;
    baseName: string;
    runnerKey: string;
    durationS: number | null;
  }>,
  w: { from: number; to: number },
  now: number,
) {
  const statKey = runnerStatKey(runner);
  const own = jobs.filter((j) => keyOf(j) === statKey);
  const started = own.filter(
    (j) => j.startedAt && j.startedAt.getTime() >= w.from,
  );
  const u = utilisation(
    busySeconds(own, w, now),
    onlineSeconds(samples, own, w, now),
    (w.to - w.from) / 1000,
  );
  return {
    jobs: started.length,
    failures: started.filter(
      (j) =>
        j.conclusion === "FAILURE" ||
        j.conclusion === "TIMED_OUT" ||
        j.conclusion === "STARTUP_FAILURE",
    ).length,
    infraFailures: started.filter((j) => isInfraFailure(j, runner.removedAt))
      .length,
    utilisation: {
      ...u,
      medianSampleIntervalS: medianSampleInterval(samples),
    },
    speedIndex: speedIndex(allJobs, statKey),
  };
}

/**
 * Live runners (org and repo level) from the Runner cache, with 7-day
 * utilisation (sampled online time ∪ job intervals), the sample interval,
 * the speed index and infra failures.
 */
export async function listRunners(
  scope: TenantScope,
  installationId: bigint,
  now: Date = new Date(),
): Promise<RunnerList> {
  await visibleInstallation(scope, installationId);
  const meta = await installationMeta(installationId);
  const from = new Date(now.getTime() - UTILISATION_WINDOW_MS);
  const w = { from: from.getTime(), to: now.getTime() };
  const [runners, repos, jobs, keyOf] = await Promise.all([
    db.runner.findMany({
      where: { installationId, removedAt: null },
      orderBy: [{ scope: "asc" }, { name: "asc" }],
    }),
    db.repository.findMany({
      where: { installationId },
      select: { id: true, fullName: true },
    }),
    jobsIn(installationId, from, now),
    jobKeyResolver(installationId),
  ]);
  const repoName = new Map(repos.map((r) => [r.id, r.fullName]));
  const samples = await samplesOf(
    installationId,
    runners.map((r) => r.key),
    from,
    now,
  );
  const allJobs = jobs
    .filter((j) => j.startedAt && j.startedAt.getTime() >= w.from)
    .map((j) => ({ ...j, runnerKey: keyOf(j) }));

  return {
    runners: runners.map((r) => {
      const m = runnerMetrics(
        r,
        jobs,
        keyOf,
        samples.get(r.key) ?? [],
        allJobs,
        w,
        now.getTime(),
      );
      return {
        key: r.key,
        scope: r.scope,
        repository:
          r.repositoryId != null
            ? {
                id: String(r.repositoryId),
                fullName: repoName.get(r.repositoryId) ?? "",
              }
            : null,
        githubRunnerId: String(r.githubRunnerId),
        name: r.name,
        os: r.os,
        labels: r.labels,
        groupName: r.groupName,
        online: r.online,
        busy: r.busy,
        ephemeral: r.ephemeral,
        firstSeenAt: r.firstSeenAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        lastOnlineAt: iso(r.lastOnlineAt),
        jobs7d: m.jobs,
        failures7d: m.failures,
        infraFailures7d: m.infraFailures,
        utilisation7d: m.utilisation,
        speedIndex7d: m.speedIndex,
      };
    }),
    repoRunnersGranted: granted(meta.permissions, "administration"),
    orgRunnersGranted:
      meta.accountType === "ORGANIZATION" &&
      granted(meta.permissions, "organization_self_hosted_runners"),
    isOrganization: meta.accountType === "ORGANIZATION",
    sampledAt: iso(meta.runnersSampledAt),
    discoveredAt: iso(meta.runnersDiscoveredAt),
  };
}

// ---------- runner detail ----------

export type RunnerDayPoint = {
  day: string;
  jobs: number;
  failures: number;
  infraFailures: number;
  busyS: number;
  onlineS: number | null;
  utilisation: number | null;
  insufficientSamples: boolean;
  peakConcurrency: number;
  p50: number | null;
  p95: number | null;
  speedIndex: number | null;
};

export type RunnerDetail = {
  runner: RunnerDto;
  range: InsightRange;
  utilisation: UtilisationDto;
  perDay: RunnerDayPoint[];
  /** Samples in the range (status timeline). */
  statusTimeline: Array<{
    t: string;
    online: boolean;
    busy: boolean;
    intervalS: number;
  }>;
  /** Duration distribution on this runner vs every job with the same labels. */
  distribution: {
    runner: {
      n: number;
      p50: number | null;
      p95: number | null;
      hist: number[];
    };
    pool: { n: number; p50: number | null; p95: number | null; hist: number[] };
    labelKey: string | null;
  };
  topJobs: Array<{
    workflowId: string | null;
    workflowName: string;
    baseName: string;
    jobs: number;
    p50: number | null;
    failures: number;
  }>;
  recentFailures: Array<{
    jobId: string;
    workflowName: string;
    baseName: string;
    conclusion: Conclusion | null;
    completedAt: string | null;
    durationS: number | null;
    infra: boolean;
  }>;
};

/** `runnerKey` is the Runner cache key ("<installationId>:<ORG|REPO>:<id>"). */
export async function getRunnerDetail(
  scope: TenantScope,
  installationId: bigint,
  runnerKey: string,
  range: InsightRange = "7d",
  now: Date = new Date(),
): Promise<RunnerDetail> {
  const inst = await visibleInstallation(scope, installationId);
  const runner = await db.runner.findFirst({
    where: { key: runnerKey, installationId },
  });
  if (!runner) throw new NotFoundError();
  const list = await listRunnersFor(scope, installationId, now, runner.key);
  const dto = list[0];
  if (!dto) throw new NotFoundError();

  const from = rangeStart(range, now);
  const sampleFrom = new Date(
    Math.max(from.getTime(), now.getTime() - 30 * DAY_MS),
  );
  const w = { from: from.getTime(), to: now.getTime() };
  const statKey = runnerStatKey(runner);
  const [jobs, samples, stats, keyOf] = await Promise.all([
    jobsIn(installationId, from, now),
    samplesOf(installationId, [runner.key], sampleFrom, now),
    db.dailyRunnerStat.findMany({
      where: {
        installationId,
        runnerKey: statKey,
        day: {
          gte: new Date(`${localDay(from, inst.timezone)}T00:00:00.000Z`),
        },
      },
      orderBy: { day: "asc" },
    }),
    jobKeyResolver(installationId),
  ]);
  const own = jobs.filter((j) => keyOf(j) === statKey);
  const ownSamples = samples.get(runner.key) ?? [];
  const u = utilisation(
    busySeconds(own, w, now.getTime()),
    onlineSeconds(ownSamples, own, w, now.getTime()),
    (w.to - w.from) / 1000,
  );

  const finished = own.filter(
    (j) => j.durationS != null && j.startedAt && j.startedAt >= from,
  );
  const labelCount = new Map<string, number>();
  for (const j of finished)
    labelCount.set(j.labelKey, (labelCount.get(j.labelKey) ?? 0) + 1);
  const labelKey =
    [...labelCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const pool = jobs.filter(
    (j) =>
      labelKey != null &&
      j.labelKey === labelKey &&
      j.durationS != null &&
      j.startedAt &&
      j.startedAt >= from,
  );
  const dist = (rows: JobRow[]) => {
    const d = rows.map((j) => j.durationS!);
    return {
      n: d.length,
      p50: percentileExact(d, 0.5),
      p95: percentileExact(d, 0.95),
      hist: histogramOf(d),
    };
  };

  const groups = new Map<string, JobRow[]>();
  for (const j of finished) {
    const k = `${j.workflowId ?? 0}\u0000${j.baseName}`;
    groups.set(k, [...(groups.get(k) ?? []), j]);
  }
  const topJobs = [...groups.values()]
    .map((g) => ({
      workflowId: g[0]!.workflowId == null ? null : String(g[0]!.workflowId),
      workflowName: g[0]!.workflowName,
      baseName: g[0]!.baseName,
      jobs: g.length,
      p50: percentileExact(
        g.map((j) => j.durationS!),
        0.5,
      ),
      failures: g.filter((j) => j.conclusion === "FAILURE").length,
    }))
    .sort((a, b) => b.jobs - a.jobs)
    .slice(0, 20);

  return {
    runner: dto,
    range,
    utilisation: {
      ...u,
      medianSampleIntervalS: medianSampleInterval(ownSamples),
    },
    perDay: stats.map((s) => {
      const windowS = 86_400;
      const du = utilisation(Number(s.busyS), Number(s.onlineS ?? 0), windowS);
      return {
        day: s.day.toISOString().slice(0, 10),
        jobs: s.jobs,
        failures: s.failures,
        infraFailures: s.infraFailures,
        busyS: Number(s.busyS),
        onlineS: num(s.onlineS),
        utilisation: du.value,
        insufficientSamples: du.insufficientSamples,
        peakConcurrency: s.peakConcurrency,
        p50: histogramPercentile(s.durHist, 0.5),
        p95: histogramPercentile(s.durHist, 0.95),
        speedIndex: s.speedIndex,
      };
    }),
    statusTimeline: ownSamples
      .filter((s) => s.sampledAt.getTime() <= now.getTime())
      .map((s) => ({
        t: s.sampledAt.toISOString(),
        online: s.online,
        busy: s.busy,
        intervalS: s.intervalS,
      })),
    distribution: { runner: dist(finished), pool: dist(pool), labelKey },
    topJobs,
    recentFailures: own
      .filter(
        (j) =>
          j.conclusion === "FAILURE" ||
          j.conclusion === "STARTUP_FAILURE" ||
          j.conclusion === "TIMED_OUT",
      )
      .sort(
        (a, b) =>
          (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0),
      )
      .slice(0, 20)
      .map((j) => ({
        jobId: String(j.id),
        workflowName: j.workflowName,
        baseName: j.baseName,
        conclusion: j.conclusion,
        completedAt: iso(j.completedAt),
        durationS: j.durationS,
        infra: isInfraFailure(j, runner.removedAt),
      })),
  };
}

/** listRunners for one runner key (keeps the DTO identical). */
async function listRunnersFor(
  scope: TenantScope,
  installationId: bigint,
  now: Date,
  key: string,
): Promise<RunnerDto[]> {
  const all = await listRunners(scope, installationId, now);
  const hit = all.runners.filter((r) => r.key === key);
  if (hit.length > 0) return hit;
  // A removed runner is not in the live list; describe it from its row.
  const r = await db.runner.findFirst({ where: { key, installationId } });
  if (!r) return [];
  return [
    {
      key: r.key,
      scope: r.scope,
      repository: null,
      githubRunnerId: String(r.githubRunnerId),
      name: r.name,
      os: r.os,
      labels: r.labels,
      groupName: r.groupName,
      online: false,
      busy: false,
      ephemeral: r.ephemeral,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      lastOnlineAt: iso(r.lastOnlineAt),
      jobs7d: 0,
      failures7d: 0,
      infraFailures7d: 0,
      utilisation7d: {
        ...utilisation(0, 0, UTILISATION_WINDOW_MS / 1000),
        medianSampleIntervalS: null,
      },
      speedIndex7d: null,
    },
  ];
}

// ---------- pools, concurrency, hosted vs self-hosted ----------

export type PoolDto = {
  labelKey: string;
  labels: string[];
  runnerKind: RunnerKind;
  jobs: number;
  /** Execution minutes (unrounded). */
  minutes: number;
  billableMinEst: number;
  avgConcurrency: number;
  peakConcurrency: number;
  queueP50: number | null;
  queueP95: number | null;
  /** Self-hosted pools: Σ busy / Σ online over runners whose labels ⊇ the pool's. */
  utilisation: UtilisationDto | null;
  runners: number;
  /** Queue p95 per local weekday (1 = Monday .. 7) and hour. */
  heatmap: Array<{
    weekday: number;
    hour: number;
    jobs: number;
    queueP95: number | null;
  }>;
};

export type PoolOverview = {
  range: InsightRange;
  pools: PoolDto[];
  /** Jobs and minutes per runner kind (hosted vs self-hosted split). */
  split: Array<{
    runnerKind: RunnerKind;
    jobs: number;
    minutes: number;
    billableMinEst: number;
  }>;
};

export async function listRunnerPools(
  scope: TenantScope,
  installationId: bigint,
  range: InsightRange = "7d",
  now: Date = new Date(),
): Promise<PoolOverview> {
  const inst = await visibleInstallation(scope, installationId);
  const from = rangeStart(range, now);
  const w = { from: from.getTime(), to: now.getTime() };
  const windowS = (w.to - w.from) / 1000;
  const [jobs, runners, heat, keyOf] = await Promise.all([
    jobsIn(installationId, from, now),
    db.runner.findMany({ where: { installationId, removedAt: null } }),
    db.$queryRaw<
      Array<{
        labelKey: string;
        runnerKind: RunnerKind;
        weekday: number;
        hour: number;
        jobs: number;
        p95: number | null;
      }>
    >`
      SELECT j."labelKey", j."runnerKind",
        extract(isodow FROM (j."createdAt" AT TIME ZONE ${inst.timezone}::text))::int AS weekday,
        extract(hour FROM (j."createdAt" AT TIME ZONE ${inst.timezone}::text))::int AS hour,
        count(*)::int AS jobs,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY j."queueS") AS p95
      FROM "WorkflowJob" j
      WHERE j."installationId" = ${installationId} AND j."queueS" IS NOT NULL
        AND j."createdAt" >= ${from} AND j."createdAt" < ${now}
      GROUP BY 1, 2, 3, 4`,
    jobKeyResolver(installationId),
  ]);
  const samples = await samplesOf(
    installationId,
    runners.map((r) => r.key),
    from,
    now,
  );

  const byPool = new Map<string, JobRow[]>();
  for (const j of jobs) {
    if (!j.startedAt && j.completedAt) continue;
    const k = `${j.runnerKind}\u0000${j.labelKey}`;
    byPool.set(k, [...(byPool.get(k) ?? []), j]);
  }
  const heatBy = new Map<string, PoolDto["heatmap"]>();
  for (const h of heat) {
    const k = `${h.runnerKind}\u0000${h.labelKey}`;
    heatBy.set(k, [
      ...(heatBy.get(k) ?? []),
      { weekday: h.weekday, hour: h.hour, jobs: h.jobs, queueP95: num(h.p95) },
    ]);
  }

  const pools: PoolDto[] = [...byPool.entries()].map(([k, list]) => {
    const kind = list[0]!.runnerKind;
    const labels = list[0]!.labels;
    const intervals = list
      .map((j) => jobInterval(j, w.to))
      .filter((i): i is Interval => i !== null)
      .map((i) => ({
        start: Math.max(i.start, w.from),
        end: Math.min(i.end, w.to),
      }))
      .filter((i) => i.end > i.start);
    const started = list.filter(
      (j) => j.startedAt && j.startedAt.getTime() >= w.from,
    );
    const queues = started
      .map((j) => j.queueS)
      .filter((v): v is number => v != null);
    let poolUtil: UtilisationDto | null = null;
    let runnerCount = 0;
    if (kind === "SELF_HOSTED") {
      const members = runners.filter((r) => labelsSatisfy(r.labels, labels));
      runnerCount = members.length;
      let busy = 0;
      let online = 0;
      const memberSamples: SampleRow[] = [];
      for (const m of members) {
        const memberKey = runnerStatKey(m);
        const own = jobs.filter((j) => keyOf(j) === memberKey);
        const s = samples.get(m.key) ?? [];
        memberSamples.push(...s);
        busy += busySeconds(own, w, w.to);
        online += onlineSeconds(s, own, w, w.to);
      }
      if (members.length > 0) {
        poolUtil = {
          ...utilisation(busy, online, windowS * members.length),
          medianSampleIntervalS: medianSampleInterval(memberSamples),
        };
      }
    }
    return {
      labelKey: list[0]!.labelKey,
      labels,
      runnerKind: kind,
      jobs: started.length,
      minutes: busySeconds(list, w, w.to) / 60,
      billableMinEst: started.reduce((s, j) => s + (j.billableMinEst ?? 0), 0),
      avgConcurrency: windowS > 0 ? busySeconds(list, w, w.to) / windowS : 0,
      peakConcurrency: peakConcurrency(intervals),
      queueP50: percentileExact(queues, 0.5),
      queueP95: percentileExact(queues, 0.95),
      utilisation: poolUtil,
      runners: runnerCount,
      heatmap: (heatBy.get(k) ?? []).sort(
        (a, b) => a.weekday - b.weekday || a.hour - b.hour,
      ),
    };
  });

  const split = new Map<RunnerKind, PoolOverview["split"][number]>();
  for (const p of pools) {
    const s = split.get(p.runnerKind) ?? {
      runnerKind: p.runnerKind,
      jobs: 0,
      minutes: 0,
      billableMinEst: 0,
    };
    s.jobs += p.jobs;
    s.minutes += p.minutes;
    s.billableMinEst += p.billableMinEst;
    split.set(p.runnerKind, s);
  }
  return {
    range,
    pools: pools.sort(
      (a, b) => b.jobs - a.jobs || a.labelKey.localeCompare(b.labelKey),
    ),
    split: [...split.values()],
  };
}

export type ConcurrencyDto = {
  from: string;
  to: string;
  bucketS: number;
  labelKey: string | null;
  buckets: ConcurrencyBucket[];
  peakRunning: number;
  peakQueued: number;
  avgRunning: number;
};

/**
 * Concurrency timeline in 5-minute buckets (at most 7 days), optionally for
 * one pool (labelKey). Longer ranges use DailyRunnerStat.peakConcurrency.
 */
export async function getConcurrencyTimeline(
  scope: TenantScope,
  installationId: bigint,
  opts: { range?: "24h" | "7d"; labelKey?: string } = {},
  now: Date = new Date(),
): Promise<ConcurrencyDto> {
  await visibleInstallation(scope, installationId);
  const range = opts.range ?? "24h";
  const from = rangeStart(range, now);
  const jobs = await jobsIn(
    installationId,
    from,
    now,
    opts.labelKey !== undefined
      ? Prisma.sql`AND j."labelKey" = ${opts.labelKey}`
      : Prisma.empty,
  );
  const buckets = concurrencyTimeline(
    jobs,
    { from: from.getTime(), to: now.getTime() },
    now.getTime(),
  );
  return {
    from: from.toISOString(),
    to: now.toISOString(),
    bucketS: 300,
    labelKey: opts.labelKey ?? null,
    buckets,
    peakRunning: Math.max(0, ...buckets.map((b) => b.running)),
    peakQueued: Math.max(0, ...buckets.map((b) => b.queued)),
    avgRunning:
      buckets.length > 0
        ? buckets.reduce((s, b) => s + b.runningAvg, 0) / buckets.length
        : 0,
  };
}

export type HostedComparisonDto = {
  range: InsightRange;
  rows: Array<{
    workflowId: string | null;
    workflowName: string;
    baseName: string;
    hosted: {
      n: number;
      p50: number | null;
      p95: number | null;
      queueP50: number | null;
      queueP95: number | null;
    };
    selfHosted: {
      n: number;
      p50: number | null;
      p95: number | null;
      queueP50: number | null;
      queueP95: number | null;
    };
    deltaP50: number | null;
    deltaP95: number | null;
  }>;
};

/** Hosted vs self-hosted for each (workflow, job) with n ≥ 5 on both kinds. */
export async function getHostedVsSelfHosted(
  scope: TenantScope,
  installationId: bigint,
  opts: { range?: InsightRange; workflowId?: bigint } = {},
  now: Date = new Date(),
): Promise<HostedComparisonDto> {
  await visibleInstallation(scope, installationId);
  const range = opts.range ?? "30d";
  const from = rangeStart(range, now);
  const jobs = (
    await jobsIn(
      installationId,
      from,
      now,
      opts.workflowId !== undefined
        ? Prisma.sql`AND j."workflowId" = ${opts.workflowId}`
        : Prisma.empty,
    )
  ).filter(
    (j) =>
      j.completedAt && j.startedAt && j.startedAt.getTime() >= from.getTime(),
  );
  const names = new Map(
    jobs.map((j) => [String(j.workflowId), j.workflowName]),
  );
  return {
    range,
    rows: compareHostedSelfHosted(jobs).map((c) => ({
      workflowId: c.workflowId == null ? null : String(c.workflowId),
      workflowName: names.get(String(c.workflowId)) ?? "",
      baseName: c.baseName,
      hosted: c.hosted,
      selfHosted: c.selfHosted,
      deltaP50: c.deltaP50,
      deltaP95: c.deltaP95,
    })),
  };
}

// ---------- live queue ----------

export type QueueJobDto = {
  jobId: string;
  runId: string;
  repositoryId: string;
  repoFullName: string;
  workflowName: string;
  name: string;
  labels: string[];
  status: "QUEUED" | "WAITING";
  createdAt: string;
  ageS: number;
  stuck: boolean;
  noMatchingRunner: boolean;
};

export type QueueGroupDto = {
  labelKey: string;
  labels: string[];
  repositoryId: string;
  repoFullName: string;
  count: number;
  oldestAgeS: number;
  p95AgeS: number | null;
  workflows: string[];
  stuck: number;
  noMatchingRunner: boolean;
};

export type LiveQueue = {
  at: string;
  groups: QueueGroupDto[];
  /** Jobs waiting for an environment approval (status WAITING), shown separately. */
  approvals: QueueJobDto[];
  jobs: QueueJobDto[];
  stuck: number;
  oldestAgeS: number | null;
};

/**
 * Live queue: jobs QUEUED (grouped by labels and repository) and WAITING
 * (environment approvals). A self-hosted job queued for over 15 minutes with
 * no free online runner whose labels ⊇ the job's (org runners, or the repo's
 * own) is STUCK; with no matching runner at all it is flagged as such.
 */
export async function getLiveQueue(
  scope: TenantScope,
  installationId: bigint,
  now: Date = new Date(),
): Promise<LiveQueue> {
  await visibleInstallation(scope, installationId);
  const [jobs, runners, repos] = await Promise.all([
    db.workflowJob.findMany({
      where: { installationId, status: { in: ["QUEUED", "WAITING"] } },
      orderBy: { createdAt: "asc" },
      take: 5_000,
      select: {
        id: true,
        runId: true,
        repositoryId: true,
        workflowName: true,
        name: true,
        labels: true,
        labelKey: true,
        status: true,
        createdAt: true,
        waitingS: true,
      },
    }),
    db.runner.findMany({
      where: { installationId, removedAt: null },
      select: {
        scope: true,
        repositoryId: true,
        labels: true,
        online: true,
        busy: true,
        removedAt: true,
      },
    }),
    db.repository.findMany({
      where: { installationId },
      select: { id: true, fullName: true },
    }),
  ]);
  const repoName = new Map(repos.map((r) => [r.id, r.fullName]));
  const queueRunners: QueueRunner[] = runners;
  const labelKeyOf = new Map(jobs.map((j) => [String(j.id), j.labelKey]));
  const dtos: QueueJobDto[] = jobs.map((j) => {
    const flags = queueFlags(j, queueRunners, now.getTime());
    return {
      jobId: String(j.id),
      runId: String(j.runId),
      repositoryId: String(j.repositoryId),
      repoFullName: repoName.get(j.repositoryId) ?? "",
      workflowName: j.workflowName,
      name: j.name,
      labels: j.labels,
      status: j.status as "QUEUED" | "WAITING",
      createdAt: j.createdAt.toISOString(),
      ageS: flags.ageS,
      stuck: j.status === "QUEUED" && flags.stuck,
      noMatchingRunner: flags.noMatchingRunner,
    };
  });
  const queued = dtos.filter((j) => j.status === "QUEUED");
  const groups = new Map<string, QueueGroupDto & { ages: number[] }>();
  for (const j of queued) {
    const labelKey = labelKeyOf.get(j.jobId) ?? "";
    const k = `${labelKey}\u0000${j.repositoryId}`;
    const g = groups.get(k) ?? {
      labelKey,
      labels: j.labels,
      repositoryId: j.repositoryId,
      repoFullName: j.repoFullName,
      count: 0,
      oldestAgeS: 0,
      p95AgeS: null,
      workflows: [],
      stuck: 0,
      noMatchingRunner: false,
      ages: [],
    };
    g.count++;
    g.ages.push(j.ageS);
    g.oldestAgeS = Math.max(g.oldestAgeS, j.ageS);
    if (!g.workflows.includes(j.workflowName)) g.workflows.push(j.workflowName);
    if (j.stuck) g.stuck++;
    g.noMatchingRunner ||= j.noMatchingRunner;
    groups.set(k, g);
  }
  return {
    at: now.toISOString(),
    groups: [...groups.values()]
      .map(({ ages, ...g }) => ({ ...g, p95AgeS: percentileExact(ages, 0.95) }))
      .sort((a, b) => b.oldestAgeS - a.oldestAgeS),
    approvals: dtos.filter((j) => j.status === "WAITING"),
    jobs: queued,
    stuck: queued.filter((j) => j.stuck).length,
    oldestAgeS:
      queued.length > 0 ? Math.max(...queued.map((j) => j.ageS)) : null,
  };
}

// ---------- daily runner stats ----------

export type RunnerStatPoint = {
  runnerKey: string;
  runnerKind: RunnerKind;
  day: string;
  jobs: number;
  failures: number;
  infraFailures: number;
  busyS: number;
  onlineS: number | null;
  peakConcurrency: number;
  p50: number | null;
  p95: number | null;
  queueP95: number | null;
  speedIndex: number | null;
};

/** DailyRunnerStat rows over a range, per runner key and day. */
export async function listRunnerDailyStats(
  scope: TenantScope,
  installationId: bigint,
  opts: { range?: InsightRange; runnerKey?: string } = {},
  now: Date = new Date(),
): Promise<RunnerStatPoint[]> {
  const inst = await visibleInstallation(scope, installationId);
  const fromDay = localDay(rangeStart(opts.range ?? "30d", now), inst.timezone);
  const rows = await db.dailyRunnerStat.findMany({
    where: {
      installationId,
      day: { gte: new Date(`${fromDay}T00:00:00.000Z`) },
      ...(opts.runnerKey ? { runnerKey: opts.runnerKey } : {}),
    },
    orderBy: [{ runnerKey: "asc" }, { day: "asc" }],
  });
  return rows.map((r) => ({
    runnerKey: r.runnerKey,
    runnerKind: r.runnerKind,
    day: r.day.toISOString().slice(0, 10),
    jobs: r.jobs,
    failures: r.failures,
    infraFailures: r.infraFailures,
    busyS: Number(r.busyS),
    onlineS: num(r.onlineS),
    peakConcurrency: r.peakConcurrency,
    p50: histogramPercentile(r.durHist, 0.5),
    p95: histogramPercentile(r.durHist, 0.95),
    queueP95: histogramPercentile(mergeHistograms(r.queueHist), 0.95),
    speedIndex: r.speedIndex,
  }));
}
