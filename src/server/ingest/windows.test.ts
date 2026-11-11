import { describe, expect, it } from "vitest";
import { Deadline, RateBudget } from "./budget";
import {
  createdQuery,
  nextBackfillWindow,
  planWindows,
  RESULT_CAP,
  windowOf,
  type Window,
} from "./windows";

/** A fake run list: `count` answers like GitHub's total_count for a window. */
function fakeCount(createdAt: number[]) {
  const calls: Window[] = [];
  const count = async (w: Window) => {
    calls.push(w);
    return createdAt.filter((s) => s >= w.from && s <= w.to).length;
  };
  return { count, calls };
}

describe("window splitting for the 1,000-result cap", () => {
  const day = 86_400;
  const w: Window = { from: 1_700_000_000, to: 1_700_000_000 + 3 * day - 1 };

  it("keeps a window below the cap whole", async () => {
    const runs = Array.from({ length: 999 }, (_, i) => w.from + i * 100);
    const { count } = fakeCount(runs);
    expect(await planWindows(w, count)).toEqual([w]);
  });

  it("splits a window with >= 1,000 results recursively until each part is below the cap", async () => {
    // 2,500 runs, clustered in the last day.
    const runs = Array.from(
      { length: 2_500 },
      (_, i) => w.to - Math.floor((i * day) / 2_500),
    );
    const { count } = fakeCount(runs);
    const leaves = await planWindows(w, count);
    expect(leaves.length).toBeGreaterThan(2);
    // Inside the window, disjoint and newest first (empty halves are dropped).
    for (const leaf of leaves) {
      expect(leaf.from).toBeGreaterThanOrEqual(w.from);
      expect(leaf.to).toBeLessThanOrEqual(w.to);
    }
    for (let i = 1; i < leaves.length; i++)
      expect(leaves[i]!.to).toBeLessThan(leaves[i - 1]!.from);
    // Every leaf is below the cap and all runs are covered exactly once.
    let total = 0;
    for (const leaf of leaves) {
      const n = await count(leaf);
      expect(n).toBeLessThan(RESULT_CAP);
      total += n;
    }
    expect(total).toBe(runs.length);
  });

  it("drops empty halves and stops at one-second windows", async () => {
    const runs = Array.from({ length: 1_200 }, () => w.from + 5);
    const { count } = fakeCount(runs);
    const leaves = await planWindows(w, count);
    expect(leaves).toEqual([{ from: w.from + 5, to: w.from + 5 }]);
  });

  it("formats the created filter in whole seconds", () => {
    expect(
      createdQuery(
        windowOf(
          new Date("2026-11-01T00:00:00.900Z"),
          new Date("2026-11-03T23:59:59Z"),
        ),
      ),
    ).toBe("2026-11-01T00:00:00Z..2026-11-03T23:59:59Z");
  });

  it("walks backfill windows of three days down to the target", () => {
    const until = new Date("2026-11-11T00:00:00Z");
    const target = new Date("2026-11-04T00:00:00Z");
    const first = nextBackfillWindow(until, target)!;
    expect(new Date(first.to * 1000).toISOString()).toBe(
      "2026-11-10T23:59:59.000Z",
    );
    expect(new Date(first.from * 1000).toISOString()).toBe(
      "2026-11-08T00:00:00.000Z",
    );
    const third = nextBackfillWindow(new Date("2026-11-05T00:00:00Z"), target)!;
    expect(new Date(third.from * 1000).toISOString()).toBe(
      "2026-11-04T00:00:00.000Z",
    );
    expect(nextBackfillWindow(target, target)).toBeNull();
  });
});

describe("budgets", () => {
  it("stops 30 s before Vercel's deadline, or after the soft budget", () => {
    let now = 1_000_000;
    const clock = () => now;
    const vercel = Deadline.forRequest(new Date(now + 300_000), 240_000, clock);
    expect(vercel.endsAt).toBe(now + 240_000);
    const short = Deadline.forRequest(new Date(now + 100_000), 240_000, clock);
    expect(short.endsAt).toBe(now + 70_000);
    const docker = Deadline.forRequest(undefined, 240_000, clock);
    expect(docker.endsAt).toBe(now + 240_000);
    now += 239_000;
    expect(docker.expired()).toBe(false);
    expect(docker.expired(5_000)).toBe(true);
  });

  it("pauses below max(500, 25% of the limit) and honours retry-after", () => {
    let now = 0;
    const budget = new RateBudget(() => now);
    budget.observe({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "1300",
      "x-ratelimit-reset": "3600",
    });
    expect(budget.paused()).toBe(false);
    budget.observe({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "1249",
      "x-ratelimit-reset": "3600",
    });
    expect(budget.paused()).toBe(true);
    expect(budget.blocked()).toBe(false);
    expect(RateBudget.reserve(1000)).toBe(500);

    const other = new RateBudget(() => now);
    other.observe({ "retry-after": "60" }, 403);
    expect(other.blocked()).toBe(true);
    now = 61_000;
    expect(other.blocked()).toBe(false);
  });
});
