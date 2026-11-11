import fc from "fast-check";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as Budget from "@/server/ingest/budget";
import type * as Deliveries from "@/server/ingest/deliveries";
import type * as Reconcile from "@/server/ingest/reconcile";
import type * as Verify from "@/server/ingest/verify";
import type * as Webhook from "@/server/ingest/webhook";
import type * as Store from "@/server/ingest/webhook-store";
import type * as Db from "@/server/db";
import {
  A,
  DATABASE_URL,
  FakeGitHub,
  makeRun,
  resetTables,
  seedInstallations,
  setActionsEnv,
  WEBHOOK_SECRET,
} from "./support/actions";

/**
 * Webhook ingestion of workflow_job and workflow_run end to end: real route
 * logic, real store, real Postgres (design §5.1, §5.2, §13 M1).
 */

vi.mock("next/cache", () => ({ revalidateTag: () => undefined }));

let db: typeof Db.db;
let webhook: typeof Webhook;
let store: typeof Store;
let verify: typeof Verify;
let deliveries: typeof Deliveries;
let reconcile: typeof Reconcile;
let budget: typeof Budget;

const repoPayload = {
  id: 11,
  name: "repo-a",
  full_name: "example-user/repo-a",
  private: true,
  default_branch: "main",
  owner: { login: "example-user" },
};

const T0 = Date.parse("2026-11-02T10:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function jobPayload(action: string, extra: Record<string, unknown> = {}) {
  return {
    action,
    installation: { id: Number(A) },
    repository: repoPayload,
    workflow_job: {
      id: 9001,
      run_id: 8001,
      run_attempt: 1,
      workflow_name: "CI",
      head_branch: "main",
      head_sha: "b".repeat(40),
      name: "build (linux)",
      labels: ["ubuntu-latest"],
      status: action,
      conclusion: null,
      created_at: at(0),
      started_at: at(0),
      completed_at: null,
      runner_id: null,
      runner_name: null,
      runner_group_id: null,
      runner_group_name: null,
      ...extra,
    },
  };
}

const runner = {
  runner_id: 7,
  runner_name: "GitHub Actions 7",
  runner_group_id: 1,
  runner_group_name: "GitHub Actions",
};

function runPayload(action: string, extra: Record<string, unknown> = {}) {
  return {
    action,
    installation: { id: Number(A) },
    repository: repoPayload,
    workflow_run: {
      id: 8001,
      workflow_id: 301,
      name: "CI",
      path: ".github/workflows/ci.yml",
      event: "push",
      head_branch: "main",
      head_sha: "b".repeat(40),
      actor: { login: "example-user" },
      run_number: 7,
      run_attempt: 1,
      status: action === "requested" ? "queued" : action,
      conclusion: null,
      created_at: at(0),
      run_started_at: at(0),
      updated_at: at(1),
      html_url: "https://github.com/example-user/repo-a/actions/runs/8001",
      ...extra,
    },
  };
}

/** The recorded delivery sequence of one run with one job. */
const sequence: Array<{ id: string; event: string; payload: object }> = [
  { id: "d-run-req", event: "workflow_run", payload: runPayload("requested") },
  { id: "d-job-q", event: "workflow_job", payload: jobPayload("queued") },
  {
    id: "d-job-ip",
    event: "workflow_job",
    payload: jobPayload("in_progress", { started_at: at(20), ...runner }),
  },
  {
    id: "d-run-ip",
    event: "workflow_run",
    payload: runPayload("in_progress", { updated_at: at(20) }),
  },
  {
    id: "d-job-done",
    event: "workflow_job",
    payload: jobPayload("completed", {
      conclusion: "success",
      started_at: at(20),
      completed_at: at(320),
      ...runner,
    }),
  },
  {
    id: "d-run-done",
    event: "workflow_run",
    payload: runPayload("completed", {
      conclusion: "success",
      updated_at: at(325),
    }),
  },
];

async function deliver(id: string, event: string, payload: object) {
  const body = JSON.stringify(payload);
  const headers = new Headers({
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": id,
    "x-hub-signature-256": verify.signPayload(WEBHOOK_SECRET, body),
  });
  return webhook.handleWebhook(
    { headers, body },
    [WEBHOOK_SECRET],
    store.prismaWebhookStore,
  );
}

/** Rows without the columns that legitimately differ between replays. */
async function snapshot() {
  const varying = ["lastEventAt", "waitingStartedAt", "lastQueuedAt"];
  const strip = (r: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => !varying.includes(k)));
  const runs = await db.workflowRun.findMany({ orderBy: { id: "asc" } });
  const jobs = await db.workflowJob.findMany({ orderBy: { id: "asc" } });
  return { runs: runs.map(strip), jobs: jobs.map(strip) };
}

describe.skipIf(!DATABASE_URL)("workflow webhooks", () => {
  beforeAll(async () => {
    setActionsEnv();
    ({ db } = await import("@/server/db"));
    webhook = await import("@/server/ingest/webhook");
    store = await import("@/server/ingest/webhook-store");
    verify = await import("@/server/ingest/verify");
    deliveries = await import("@/server/ingest/deliveries");
    reconcile = await import("@/server/ingest/reconcile");
    budget = await import("@/server/ingest/budget");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await resetTables(db);
    await seedInstallations(db);
  });

  it("folds a delivery sequence into a completed run and job", async () => {
    for (const d of sequence) {
      const res = await deliver(d.id, d.event, d.payload);
      expect(res.status).toBe(202);
      expect(res.body.result).toBe("processed");
    }
    const run = await db.workflowRun.findUniqueOrThrow({
      where: { id: 8001n },
    });
    expect(run).toMatchObject({
      installationId: A,
      repositoryId: 11n,
      workflowId: 301n,
      status: "COMPLETED",
      conclusion: "SUCCESS",
      firstAttemptConclusion: "SUCCESS",
      isPlaceholder: false,
      durationS: 325,
      isDefaultBranch: true,
      source: "WEBHOOK",
    });
    const job = await db.workflowJob.findUniqueOrThrow({
      where: { id: 9001n },
    });
    expect(job).toMatchObject({
      workflowId: 301n,
      status: "COMPLETED",
      conclusion: "SUCCESS",
      queueS: 20,
      durationS: 300,
      runnerKind: "GITHUB_HOSTED",
      runnerOs: "LINUX",
      sku: "linux",
      billableMinEst: 5,
      baseName: "build",
    });
    // Payloads are nulled once processed; the days are marked for rollup.
    const rows = await db.webhookDelivery.findMany();
    expect(rows).toHaveLength(sequence.length);
    for (const r of rows) {
      expect(r.status).toBe("PROCESSED");
      expect(r.payload).toBeNull();
    }
    expect(await db.rollupDirty.count({ where: { installationId: A } })).toBe(
      1,
    );
  });

  it(
    "converges to the same rows for duplicated and out-of-order deliveries",
    { timeout: 240_000 },
    async () => {
      for (const d of sequence) await deliver(d.id, d.event, d.payload);
      const expected = await snapshot();

      await fc.assert(
        fc.asyncProperty(
          fc
            .array(fc.nat({ max: sequence.length - 1 }), { maxLength: 4 })
            .chain((dups) => {
              const all = [...sequence.map((_, i) => i), ...dups];
              return fc.shuffledSubarray(all, {
                minLength: all.length,
                maxLength: all.length,
              });
            }),
          async (order) => {
            await resetTables(db);
            await seedInstallations(db);
            for (const [n, i] of order.entries()) {
              const d = sequence[i]!;
              // Duplicates arrive both as the same delivery and as a GitHub redelivery (new id).
              const id =
                order.indexOf(i) === n ? d.id : `${d.id}-redelivery-${n}`;
              await deliver(id, d.event, d.payload);
            }
            expect(await snapshot()).toEqual(expected);
          },
        ),
        { numRuns: 15 },
      );
    },
  );

  it("answers a duplicate delivery id with 200 and changes nothing", async () => {
    const d = sequence[4]!;
    expect((await deliver(d.id, d.event, d.payload)).status).toBe(202);
    const before = await snapshot();
    const again = await deliver(d.id, d.event, d.payload);
    expect(again.status).toBe(200);
    expect(again.body.result).toBe("duplicate");
    expect(await snapshot()).toEqual(before);
  });

  it("creates a placeholder run when a job arrives first", async () => {
    await deliver("d-job-q", "workflow_job", jobPayload("queued"));
    const run = await db.workflowRun.findUniqueOrThrow({
      where: { id: 8001n },
    });
    expect(run).toMatchObject({
      isPlaceholder: true,
      workflowName: "CI",
      headSha: "b".repeat(40),
    });
    await deliver("d-run-req", "workflow_run", runPayload("requested"));
    const real = await db.workflowRun.findUniqueOrThrow({
      where: { id: 8001n },
    });
    expect(real.isPlaceholder).toBe(false);
    expect(real.workflowId).toBe(301n);
    // The job learns the workflow id from its run.
    expect(
      (await db.workflowJob.findUniqueOrThrow({ where: { id: 9001n } }))
        .workflowId,
    ).toBe(301n);
  });

  it("measures an environment approval wait and excludes it from queue time", async () => {
    // Receipt times are the event times; simulate them through the stored rows.
    const steps: Array<[string, object]> = [
      ["d-q1", jobPayload("queued")],
      ["d-w", jobPayload("waiting")],
      ["d-q2", jobPayload("queued")],
      ["d-ip", jobPayload("in_progress", { started_at: at(0), ...runner })],
    ];
    const { processDelivery } = webhook;
    for (const [n, [id, payload]] of steps.entries()) {
      const receivedAt = new Date(Date.now() + n * 60_000);
      await db.webhookDelivery.create({
        data: {
          id,
          event: "workflow_job",
          payloadBytes: 1,
          payload: payload as object,
          status: "RECEIVED",
          installationId: A,
          receivedAt,
        },
      });
      await processDelivery(store.prismaWebhookStore, {
        id,
        event: "workflow_job",
        payload: payload as never,
        receivedAt,
      });
    }
    const job = await db.workflowJob.findUniqueOrThrow({
      where: { id: 9001n },
    });
    // waiting at +1 min, queued again at +2 min
    expect(job.waitingS).toBe(60);
  });

  it("replays a delivery that was recorded but not folded (step a)", async () => {
    const d = sequence[4]!;
    await db.webhookDelivery.create({
      data: {
        id: "d-stuck",
        event: d.event,
        action: "completed",
        installationId: A,
        repositoryId: 11n,
        payloadBytes: 10,
        payload: d.payload as object,
        status: "RECEIVED",
        receivedAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    const res = await deliveries.replayDeliveries(
      new budget.Deadline(Date.now() + 60_000),
    );
    expect(res.replayed).toBe(1);
    const row = await db.webhookDelivery.findUniqueOrThrow({
      where: { id: "d-stuck" },
    });
    expect(row.status).toBe("PROCESSED");
    expect(row.payload).toBeNull();
    expect(await db.workflowJob.count()).toBe(1);
  });

  it("marks deliveries DEAD after eight failed attempts", async () => {
    await db.webhookDelivery.create({
      data: {
        id: "d-dead",
        event: "workflow_job",
        installationId: A,
        payloadBytes: 10,
        payload: { broken: true },
        status: "FAILED",
        attempts: 8,
      },
    });
    const res = await deliveries.replayDeliveries(
      new budget.Deadline(Date.now() + 60_000),
    );
    expect(res.dead).toBe(1);
    expect(
      (await db.webhookDelivery.findUniqueOrThrow({ where: { id: "d-dead" } }))
        .status,
    ).toBe("DEAD");
  });

  it("recovers a delivery dropped while the database was down (step b)", async () => {
    const gh = new FakeGitHub();
    const recent = new Date(Date.now() - 60_000).toISOString();
    gh.hookDeliveries = [
      // 503 while the DB was unreachable: unknown locally -> redeliver
      {
        id: 31,
        guid: "g-503",
        delivered_at: recent,
        status_code: 503,
        event: "workflow_job",
        installation_id: Number(A),
        repository_id: 11,
      },
      // oversized: never redelivered, the repo is resynced instead
      {
        id: 32,
        guid: "g-413",
        delivered_at: recent,
        status_code: 413,
        event: "workflow_run",
        installation_id: Number(A),
        repository_id: 11,
      },
      // failed once, then succeeded on redelivery: nothing to do
      {
        id: 33,
        guid: "g-ok",
        delivered_at: recent,
        status_code: 500,
        event: "workflow_job",
        installation_id: Number(A),
        repository_id: 11,
      },
      {
        id: 34,
        guid: "g-ok",
        delivered_at: recent,
        status_code: 202,
        event: "workflow_job",
        installation_id: Number(A),
        repository_id: 11,
      },
      // older than 72 h: out of scope
      {
        id: 5,
        guid: "g-old",
        delivered_at: new Date(Date.now() - 80 * 3_600_000).toISOString(),
        status_code: 503,
        event: "workflow_job",
        installation_id: Number(A),
        repository_id: 11,
      },
    ];
    await db.syncState.create({
      data: { repositoryId: 11n, installationId: A },
    });

    const result = await deliveries.repairHookDeliveries(
      gh.api(null),
      new budget.Deadline(Date.now() + 60_000),
    );
    expect(gh.redelivered).toEqual([31]);
    expect(result).toMatchObject({ redelivered: 1, resync: 1, complete: true });
    expect(
      (await db.syncState.findUniqueOrThrow({ where: { repositoryId: 11n } }))
        .needsResync,
    ).toBe(true);

    // GitHub redelivers: the delivery is processed like the original.
    const d = sequence[1]!;
    expect((await deliver("g-503", d.event, d.payload)).body.result).toBe(
      "processed",
    );
    expect(await db.workflowJob.count()).toBe(1);

    // The cursor advanced: a second walk does not redeliver again.
    await deliveries.repairHookDeliveries(
      gh.api(null),
      new budget.Deadline(Date.now() + 60_000),
    );
    expect(gh.redelivered).toEqual([31]);
  });

  it("completes placeholder runs from REST in lean mode", async () => {
    // Lean mode: only workflow_job is subscribed.
    const made = makeRun(
      { owner: "example-user", name: "repo-a" },
      { id: 8001, createdAt: new Date(Date.now() - 3_600_000), durationS: 300 },
    );
    const gh = new FakeGitHub();
    gh.addRun(A, {
      id: 8001,
      createdAt: new Date(Date.now() - 3_600_000),
      durationS: 300,
    });
    await deliver("d-lean-job", "workflow_job", {
      action: "completed",
      installation: { id: Number(A) },
      repository: repoPayload,
      workflow_job: made.jobs[0],
    });
    expect(
      (await db.workflowRun.findUniqueOrThrow({ where: { id: 8001n } }))
        .isPlaceholder,
    ).toBe(true);

    await reconcile.runReconcile({
      deadline: new budget.Deadline(gh.now + 600_000, gh.clock),
      clients: gh.clients(),
      installationId: A,
      config: { lean: true, backfillDays: 0 },
    });
    const run = await db.workflowRun.findUniqueOrThrow({
      where: { id: 8001n },
    });
    expect(run).toMatchObject({
      isPlaceholder: false,
      status: "COMPLETED",
      conclusion: "SUCCESS",
      workflowId: 301n,
    });
  });
});
