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
import type * as Costs from "@/server/data/costs";
import type * as Insights from "@/server/data/insights";
import type * as Summaries from "@/server/data/summaries";
import type * as Budget from "@/server/ingest/budget";
import type * as Reconcile from "@/server/ingest/reconcile";
import type * as Db from "@/server/db";
import {
  A,
  DATABASE_URL,
  FakeGitHub,
  resetTables,
  seedInstallations,
  setActionsEnv,
} from "./support/actions";

/**
 * One seeded dataset, the same figure on every page (UI overhaul §4.3):
 * the start page card, the overview, the repository list and the
 * repository page agree on the runs, success rate and minutes of "7 d",
 * the overview draws exactly 7 daily bars, and the start page card and the
 * costs page show the same minutes used this month.
 */

vi.mock("next/cache", () => ({ revalidateTag: () => undefined }));

const HOUR = 3_600_000;

let db: typeof Db.db;
let insights: typeof Insights;
let summaries: typeof Summaries;
let costs: typeof Costs;
let reconcile: typeof Reconcile;
let budget: typeof Budget;

const viewer: TenantScope = {
  userId: "user-1",
  role: "VIEWER",
  installationIds: [A],
};

describe.skipIf(!DATABASE_URL)("figures agree across pages", () => {
  beforeAll(async () => {
    setActionsEnv();
    ({ db } = await import("@/server/db"));
    insights = await import("@/server/data/insights");
    summaries = await import("@/server/data/summaries");
    costs = await import("@/server/data/costs");
    reconcile = await import("@/server/ingest/reconcile");
    budget = await import("@/server/ingest/budget");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await resetTables(db);
  });

  it(
    "7 d means the same window on the start page, overview, repo list and repo page",
    { timeout: 60_000 },
    async () => {
      await seedInstallations(db);
      const gh = new FakeGitHub();
      // Runs every 7 hours over 15 days, so some fall between "7 calendar
      // days" and "168 hours" and on both sides of the 7-day trend split.
      for (let h = 1; h < 15 * 24; h += 7)
        gh.addRun(A, {
          createdAt: new Date(gh.now - h * HOUR),
          durationS: 60 + (h % 5) * 90,
          conclusion: h % 4 === 0 ? "failure" : "success",
        });
      expect(
        (
          await reconcile.runReconcile({
            deadline: new budget.Deadline(gh.now + 3_600_000, gh.clock),
            clients: gh.clients(),
            installationId: A,
            config: { backfillDays: 35 },
          })
        ).installations[0]!.status,
      ).toBe("ok");
      const now = new Date(gh.now);

      const [card] = await summaries.getAccountSummaries(viewer, now);
      const overview = await insights.getInstallationOverview(
        viewer,
        A,
        "7d",
        now,
      );
      const list = await insights.listRepoStats(
        viewer,
        A,
        { range: "7d" },
        now,
      );
      const repo = list.rows.find((r) => r.name === "repo-a")!;
      const detail = await insights.getRepositorySummary(
        viewer,
        A,
        BigInt(repo.repositoryId),
        "7d",
        now,
      );

      expect(overview.summary.runs).toBeGreaterThan(0);
      expect(card!.runs7d).toBe(overview.summary.runs);
      expect(card!.successRate7d).toBeCloseTo(
        overview.summary.successRate!,
        10,
      );
      expect(card!.successDelta).toBeCloseTo(overview.successRateDelta!, 10);
      // Exactly 7 daily buckets: today and the 6 days before.
      expect(overview.perDay).toHaveLength(7);
      expect(overview.perBucket).toHaveLength(7);
      // The repository list and the repository page: runs and minutes.
      expect(repo.runs).toBe(overview.summary.runs);
      expect(detail.summary.runs).toBe(repo.runs);
      expect(repo.billableMinEst).toBeGreaterThan(0);
      expect(detail.billableMinEst).toBe(repo.billableMinEst);
      expect(overview.billableMinEst).toBe(repo.billableMinEst);
      // The card's 14-day trend ends today.
      expect(card!.sparkline).toHaveLength(14);
      expect(card!.sparkline.at(-1)!.day).toBe(now.toISOString().slice(0, 10));
    },
  );

  it("the start page and the costs page show the same minutes used", async () => {
    await seedInstallations(db);
    const now = new Date();
    const month = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    await db.billingUsageItem.createMany({
      data: [
        { sku: "Actions Linux", quantity: 100 },
        // Windows minutes count twice against the included minutes.
        { sku: "Actions Windows", quantity: 50 },
      ].map((b) => ({
        installationId: A,
        date: month,
        product: "Actions",
        sku: b.sku,
        repositoryFullName: "example-user/repo-a",
        unitType: "Minutes",
        quantity: b.quantity,
        pricePerUnit: 0.008,
        grossAmount: b.quantity * 0.008,
        discountAmount: 0,
        netAmount: b.quantity * 0.008,
        fetchedAt: now,
      })),
    });
    const [card] = await summaries.getAccountSummaries(viewer, now);
    const c = await costs.getCosts(viewer, A, undefined, now);
    expect(c.source).toBe("billed");
    expect(card!.minutes.source).toBe("billed");
    expect(c.included.used).toBe(200);
    expect(card!.minutes.used).toBe(c.included.used);
  });
});
