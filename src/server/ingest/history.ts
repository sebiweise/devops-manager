import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import type { SkuRateLike } from "@/server/metrics/classify";
import { localDayDate } from "@/server/metrics/days";
import {
  foldJob,
  foldRun,
  placeholderRunEvent,
  type JobEvent,
  type JobRow,
  type RunEvent,
  type RunRow,
} from "./fold";
import { loadSkuRates } from "./sku-rates";

/**
 * Applies fold events to the database (design §5.2). Each call runs in one
 * transaction: insert the folded row if it does not exist, otherwise lock it
 * (`SELECT ... FOR UPDATE`), fold in TypeScript and write it back. Locks are
 * always taken run first, then jobs, so concurrent deliveries cannot
 * deadlock. Every touched (repository, day) is marked in RollupDirty.
 */

type Tx = Prisma.TransactionClient;

/** A run with 100 jobs is one transaction; the default 5 s is too short on a cold DB. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

export type RepoContext = {
  installationId: bigint;
  repositoryId: bigint;
  timezone: string;
  repoPrivate: boolean;
  rates: ReadonlyArray<SkuRateLike>;
};

/** Timezone, repo visibility and SKU rates for a fold. */
export async function loadRepoContext(
  installationId: bigint,
  repositoryId: bigint,
): Promise<RepoContext> {
  const [installation, repo, rates] = await Promise.all([
    db.installation.findUnique({
      where: { id: installationId },
      select: { timezone: true },
    }),
    db.repository.findUnique({
      where: { id: repositoryId },
      select: { private: true },
    }),
    loadSkuRates(),
  ]);
  return {
    installationId,
    repositoryId,
    timezone: installation?.timezone ?? "UTC",
    repoPrivate: repo?.private ?? true,
    rates,
  };
}

export async function markDirty(
  tx: Tx,
  installationId: bigint,
  repositoryId: bigint,
  instants: ReadonlyArray<Date | null | undefined>,
  timezone: string,
): Promise<void> {
  const days = new Set<string>();
  for (const at of instants)
    if (at) days.add(localDayDate(at, timezone).toISOString().slice(0, 10));
  for (const day of days) {
    await tx.$executeRaw`
      INSERT INTO "RollupDirty" ("installationId", "repositoryId", "day", "markedAt")
      VALUES (${installationId}, ${repositoryId}, ${day}::date, now())
      ON CONFLICT ("installationId", "repositoryId", "day")
      DO UPDATE SET "markedAt" = now()`;
  }
}

function runData(row: RunRow) {
  return row satisfies Prisma.WorkflowRunUncheckedCreateInput;
}

function jobData(row: JobRow) {
  return row satisfies Prisma.WorkflowJobUncheckedCreateInput;
}

function omitId<T extends { id: unknown }>(row: T): Omit<T, "id"> {
  const copy: Partial<T> = { ...row };
  delete copy.id;
  return copy as Omit<T, "id">;
}

function sameRow(a: object, b: object): boolean {
  const norm = (v: unknown): unknown =>
    v instanceof Date
      ? v.getTime()
      : typeof v === "bigint"
        ? `${v}n`
        : Array.isArray(v)
          ? v.map(norm)
          : v;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every(
    (k) =>
      JSON.stringify(norm((a as Record<string, unknown>)[k])) ===
      JSON.stringify(norm((b as Record<string, unknown>)[k])),
  );
}

/** Folds one run event inside `tx`; returns the previous and the new row. */
export async function foldRunTx(
  tx: Tx,
  ev: RunEvent,
): Promise<{ prev: RunRow | null; row: RunRow }> {
  const fresh = foldRun(null, ev);
  const { count } = await tx.workflowRun.createMany({
    data: [runData(fresh)],
    skipDuplicates: true,
  });
  if (count === 1) return { prev: null, row: fresh };

  await tx.$queryRaw`SELECT 1 FROM "WorkflowRun" WHERE "id" = ${ev.id} FOR UPDATE`;
  const prev = (await tx.workflowRun.findUniqueOrThrow({
    where: { id: ev.id },
  })) as RunRow;
  const row = foldRun(prev, ev);
  if (!sameRow(prev, row)) {
    await tx.workflowRun.update({
      where: { id: ev.id },
      data: omitId(runData(row)),
    });
  }
  return { prev, row };
}

/** Folds one job event inside `tx` (its run must already be locked). */
export async function foldJobTx(
  tx: Tx,
  ev: JobEvent,
  ctx: RepoContext,
  workflowId: bigint | null,
): Promise<{ prev: JobRow | null; row: JobRow }> {
  const foldCtx = { rates: ctx.rates, repoPrivate: ctx.repoPrivate };
  const fresh = { ...foldJob(null, ev, foldCtx), workflowId };
  const { count } = await tx.workflowJob.createMany({
    data: [jobData(fresh)],
    skipDuplicates: true,
  });
  if (count === 1) return { prev: null, row: fresh };

  await tx.$queryRaw`SELECT 1 FROM "WorkflowJob" WHERE "id" = ${ev.id} FOR UPDATE`;
  const prev = (await tx.workflowJob.findUniqueOrThrow({
    where: { id: ev.id },
  })) as JobRow;
  const folded = foldJob(prev, ev, foldCtx);
  const row = { ...folded, workflowId: workflowId ?? folded.workflowId };
  if (!sameRow(prev, row)) {
    await tx.workflowJob.update({
      where: { id: ev.id },
      data: omitId(jobData(row)),
    });
  }
  return { prev, row };
}

async function afterRunFold(
  tx: Tx,
  ctx: RepoContext,
  prev: RunRow | null,
  row: RunRow,
) {
  if (row.workflowId != null && prev?.workflowId !== row.workflowId) {
    // Jobs folded before their run learn the workflow id now.
    await tx.$executeRaw`
      UPDATE "WorkflowJob" SET "workflowId" = ${row.workflowId}
      WHERE "runId" = ${row.id} AND "workflowId" IS DISTINCT FROM ${row.workflowId}`;
  }
  await markDirty(
    tx,
    ctx.installationId,
    ctx.repositoryId,
    [prev?.createdAt, row.createdAt],
    ctx.timezone,
  );
}

/** Applies a workflow_run event (webhook, REST snapshot or attempt). */
export async function applyRunEvent(
  ev: RunEvent,
  ctx?: RepoContext,
): Promise<RunRow> {
  const c = ctx ?? (await loadRepoContext(ev.installationId, ev.repositoryId));
  return db.$transaction(async (tx) => {
    const { prev, row } = await foldRunTx(tx, ev);
    await afterRunFold(tx, c, prev, row);
    return row;
  }, TX_OPTIONS);
}

export type JobBatchItem = {
  job: JobEvent;
  headSha: string;
  headBranch: string | null;
};

/**
 * Applies job events of one run in one transaction. Every job also folds a
 * placeholder event into its run, so a job never waits for its run and the
 * result does not depend on which of the two arrived first.
 */
export async function applyJobEvents(
  items: ReadonlyArray<JobBatchItem>,
  ctx?: RepoContext,
): Promise<JobRow[]> {
  if (items.length === 0) return [];
  const first = items[0]!.job;
  const c =
    ctx ?? (await loadRepoContext(first.installationId, first.repositoryId));
  const byRun = new Map<bigint, JobBatchItem[]>();
  for (const item of items) {
    const list = byRun.get(item.job.runId) ?? [];
    list.push(item);
    byRun.set(item.job.runId, list);
  }

  return db.$transaction(async (tx) => {
    const out: JobRow[] = [];
    for (const list of [...byRun.values()]) {
      let run: RunRow | null = null;
      let prevRun: RunRow | null | undefined;
      for (const item of list) {
        const folded = await foldRunTx(tx, placeholderRunEvent(item.job, item));
        if (prevRun === undefined) prevRun = folded.prev;
        run = folded.row;
      }
      if (run) await afterRunFold(tx, c, prevRun ?? null, run);

      const sorted = [...list].sort((a, b) =>
        a.job.id < b.job.id ? -1 : a.job.id > b.job.id ? 1 : 0,
      );
      let selfHosted = false;
      for (const item of sorted) {
        const { prev, row } = await foldJobTx(
          tx,
          item.job,
          c,
          run?.workflowId ?? null,
        );
        await markDirty(
          tx,
          c.installationId,
          c.repositoryId,
          [prev?.createdAt, row.createdAt],
          c.timezone,
        );
        if (row.runnerKind === "SELF_HOSTED") selfHosted = true;
        out.push(row);
      }
      if (selfHosted) {
        await tx.repository.updateMany({
          where: { id: c.repositoryId, hasSelfHosted: false },
          data: { hasSelfHosted: true },
        });
      }
    }
    return out;
  }, TX_OPTIONS);
}

/** Records that the jobs of a run were read from REST. */
export async function markJobsSynced(runId: bigint, at: Date): Promise<void> {
  await db.workflowRun.updateMany({
    where: { id: runId },
    data: { jobsSyncedAt: at },
  });
}
