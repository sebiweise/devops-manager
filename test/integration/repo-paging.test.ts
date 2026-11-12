import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { TenantScope } from "@/server/authz/scope";
import type * as Insights from "@/server/data/insights";
import type * as Installations from "@/server/data/installations";
import type * as Db from "@/server/db";
import type * as ActionsEvents from "@/server/ingest/actions-events";
import {
  A,
  B,
  DATABASE_URL,
  makeRun,
  resetTables,
  seedInstallations,
  setActionsEnv,
} from "./support/actions";

/**
 * Server-side paging, search, sort and filters of the repositories table
 * (UI overhaul §4.1) against a real Postgres: LIMIT/OFFSET with an
 * allow-listed ORDER BY (nulls last, name tie-break), the filter chips, the
 * "select all matching" list, and installation isolation.
 */

vi.mock("next/cache", () => ({ revalidateTag: () => undefined }));

const DAY = 86_400_000;
let db: typeof Db.db;
let insights: typeof Insights;
let installations: typeof Installations;
let events: typeof ActionsEvents;

const scope = (...ids: bigint[]): TenantScope => ({
  userId: "user-viewer",
  role: "VIEWER",
  installationIds: ids,
});

/** 30 repos of example-user: every 3rd a fork, every 5th archived, every 4th public. */
const REPOS = Array.from({ length: 30 }, (_, i) => ({
  id: BigInt(1000 + i),
  name: `repo-${String(i + 1).padStart(2, "0")}`,
  fork: i % 3 === 0,
  archived: i % 5 === 0,
  private: i % 4 !== 0,
}));

describe.skipIf(!DATABASE_URL)("repository paging", () => {
  const now = new Date();

  beforeAll(async () => {
    setActionsEnv();
    ({ db } = await import("@/server/db"));
    insights = await import("@/server/data/insights");
    installations = await import("@/server/data/installations");
    events = await import("@/server/ingest/actions-events");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await resetTables(db);
    await seedInstallations(db);
    await db.repository.createMany({
      data: REPOS.map((r) => ({
        id: r.id,
        installationId: A,
        ownerLogin: "example-user",
        name: r.name,
        fullName: `example-user/${r.name}`,
        private: r.private,
        fork: r.fork,
        archived: r.archived,
      })),
    });
    // Runs for the first 6 repos: repo-0n gets n runs; repo-02 and repo-05 last failed.
    for (const [i, r] of REPOS.slice(0, 6).entries()) {
      for (let k = 0; k <= i; k++) {
        const made = makeRun(
          { owner: "example-user", name: r.name },
          {
            createdAt: new Date(now.getTime() - DAY + k * 60_000 + i * 1000),
            durationS: 60 * (i + 1),
            workflowId: 500 + i,
            conclusion: (i === 1 || i === 4) && k === i ? "failure" : "success",
          },
        );
        await events.applyGhRun(A, r.id, made.run, "main", now, "WEBHOOK");
        await events.applyGhJobs(A, r.id, made.jobs, now, "WEBHOOK");
      }
    }
  });

  it("pages with LIMIT/OFFSET and reports the total", async () => {
    const p1 = await insights.listRepoStats(
      scope(A),
      A,
      { sort: "name", dir: "asc", size: 25, page: 1 },
      now,
    );
    // repo-a of the shared seed plus the 30 created here.
    expect(p1.total).toBe(31);
    expect(p1.rows).toHaveLength(25);
    expect(p1.rows[0]!.fullName).toBe("example-user/repo-01");
    const p2 = await insights.listRepoStats(
      scope(A),
      A,
      { sort: "name", dir: "asc", size: 25, page: 2 },
      now,
    );
    expect(p2.page).toBe(2);
    expect(p2.rows.map((r) => r.fullName)).toEqual([
      "example-user/repo-26",
      "example-user/repo-27",
      "example-user/repo-28",
      "example-user/repo-29",
      "example-user/repo-30",
      "example-user/repo-a",
    ]);
    // A page past the end clamps to the last one.
    const far = await insights.listRepoStats(
      scope(A),
      A,
      { sort: "name", dir: "asc", size: 25, page: 99 },
      now,
    );
    expect(far.page).toBe(2);
    expect(far.counts).toEqual({ active: 31, ignored: 0, forks: 10 });
  });

  it("sorts by a metric with nulls last and the name as tie-break", async () => {
    const desc = await insights.listRepoStats(
      scope(A),
      A,
      { sort: "runs", dir: "desc", size: 8 },
      now,
    );
    expect(desc.rows.map((r) => [r.name, r.runs])).toEqual([
      ["repo-06", 6],
      ["repo-05", 5],
      ["repo-04", 4],
      ["repo-03", 3],
      ["repo-02", 2],
      ["repo-01", 1],
      ["repo-07", 0],
      ["repo-08", 0],
    ]);
    const p50 = await insights.listRepoStats(
      scope(A),
      A,
      { sort: "p50", dir: "asc", size: 7 },
      now,
    );
    // Repos without runs have no p50 and come last in both directions.
    expect(p50.rows.slice(0, 6).map((r) => r.name)).toEqual([
      "repo-01",
      "repo-02",
      "repo-03",
      "repo-04",
      "repo-05",
      "repo-06",
    ]);
    expect(p50.rows[6]!.p50Duration).toBeNull();
    // The default order is the last run, newest first.
    const def = await insights.listRepoStats(scope(A), A, { size: 3 }, now);
    expect(def.rows.map((r) => r.name)).toEqual([
      "repo-06",
      "repo-05",
      "repo-04",
    ]);
    // An unknown sort key falls back to the default.
    const bogus = await insights.listRepoStats(
      scope(A),
      A,
      { sort: "drop table" as never, size: 3 },
      now,
    );
    expect(bogus.rows.map((r) => r.name)).toEqual(def.rows.map((r) => r.name));
  });

  it("searches and filters", async () => {
    const q = await insights.listRepoStats(
      scope(A),
      A,
      { q: "REPO-1", sort: "name", dir: "asc" },
      now,
    );
    expect(q.rows.map((r) => r.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `repo-${10 + i}`),
    );
    // Search text is a literal, not a pattern.
    expect(
      (await insights.listRepoStats(scope(A), A, { q: "%" }, now)).total,
    ).toBe(0);
    const forks = await insights.listRepoStats(
      scope(A),
      A,
      { filters: ["forks"], sort: "name", dir: "asc", size: 100 },
      now,
    );
    expect(forks.total).toBe(10);
    expect(forks.rows.every((r) => r.fork)).toBe(true);
    const archivedPrivate = await insights.listRepoStats(
      scope(A),
      A,
      { filters: ["archived", "private"], size: 100 },
      now,
    );
    expect(archivedPrivate.rows.every((r) => r.archived && r.private)).toBe(
      true,
    );
    const failing = await insights.listRepoStats(
      scope(A),
      A,
      { filters: ["failing"], sort: "name", dir: "asc" },
      now,
    );
    expect(failing.rows.map((r) => r.name)).toEqual(["repo-02", "repo-05"]);
    // "Select all matching" lists every match, not only the page.
    const matching = await insights.listRepoStats(
      scope(A),
      A,
      { filters: ["forks"], size: 25, withMatching: true },
      now,
    );
    expect(matching.matching).toHaveLength(10);
  });

  it("hides ignored repositories unless asked and never shows another installation", async () => {
    await db.repository.update({
      where: { id: REPOS[0]!.id },
      data: { ignoredAt: now },
    });
    const page = await insights.listRepoStats(
      scope(A, B),
      A,
      { size: 100 },
      now,
    );
    expect(page.total).toBe(30);
    expect(page.rows.some((r) => r.name === "repo-01")).toBe(false);
    expect(page.rows.every((r) => r.fullName.startsWith("example-user/"))).toBe(
      true,
    );
    const shown = await insights.listRepoStats(
      scope(A),
      A,
      { filters: ["ignored"], q: "repo-01" },
      now,
    );
    expect(
      shown.rows.map((r) => [r.name, r.ignored, r.runs, r.sparkline]),
    ).toEqual([["repo-01", true, 0, []]]);
    // Ignored repos are not offered for "select all matching".
    const matching = await insights.listRepoStats(
      scope(A),
      A,
      { filters: ["ignored", "forks"], withMatching: true },
      now,
    );
    expect(matching.matching!.some((r) => r.fullName.endsWith("repo-01"))).toBe(
      false,
    );
    await expect(
      insights.listRepoStats(scope(B), A, {}, now),
    ).rejects.toBeInstanceOf(installations.NotFoundError);
    const other = await insights.listRepoStats(scope(A, B), B, {}, now);
    expect(other.rows.map((r) => r.fullName)).toEqual(["example-org/repo-b"]);
  });

  it("summarises every visible account from rollups and counts", async () => {
    const rollup = await import("@/server/ingest/rollup");
    const budget = await import("@/server/ingest/budget");
    await rollup.markAllDaysDirty(A, "UTC");
    await rollup.drainRollups(
      A,
      "UTC",
      new budget.Deadline(Date.now() + 60_000),
      90,
    );
    await db.repository.update({
      where: { id: REPOS[5]!.id },
      data: { ignoredAt: now },
    });
    const summaries = await import("@/server/data/summaries");
    const all = await summaries.getAccountSummaries(scope(A, B), now);
    const a = all.find((s) => s.accountLogin === "example-user")!;
    // repo-06 (6 runs) is ignored: 1+2+3+4+5 runs remain.
    expect(a).toMatchObject({
      repositories: 30,
      ignored: 1,
      runs7d: 15,
      failingWorkflows: 2,
    });
    expect(a.sparkline).toHaveLength(14);
    expect(a.sparkline.reduce((s, p) => s + p.runs, 0)).toBe(15);
    expect(a.attention.map((w) => w.repoFullName).sort()).toEqual([
      "example-user/repo-02",
      "example-user/repo-05",
    ]);
    expect(all.map((s) => s.accountLogin).sort()).toEqual([
      "example-org",
      "example-user",
    ]);
    // Only visible installations are summarised.
    expect(
      (await summaries.getAccountSummaries(scope(B), now)).map(
        (s) => s.accountLogin,
      ),
    ).toEqual(["example-org"]);
  });
});
