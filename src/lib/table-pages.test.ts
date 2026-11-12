import { describe, expect, it } from "vitest";
import type { Costs } from "@/server/data/costs";
import type { RunSummary, WorkflowStat } from "@/server/data/insights";
import type { QueueGroupDto, RunnerDto } from "@/server/data/runners";
import {
  costRepoRows,
  pageCostRepos,
  pageQueueGroups,
  pageRunners,
  pageWorkflows,
  runnerState,
} from "./table-pages";

const summary = (s: Partial<RunSummary>): RunSummary => ({
  runs: 20,
  success: 18,
  failure: 2,
  cancelled: 0,
  other: 0,
  firstTrySuccess: 18,
  flakyRecovered: 0,
  successRate: 0.9,
  firstTrySuccessRate: 0.9,
  flakyRate: 0,
  n: 20,
  p50: 60,
  p95: 120,
  queueP95: 5,
  approx: false,
  ...s,
});

const wf = (
  name: string,
  repo: string,
  s: Partial<RunSummary> = {},
  extra: Partial<WorkflowStat> = {},
): WorkflowStat => ({
  workflowId: name,
  workflowName: name,
  repositoryId: repo,
  repoFullName: `example-org/${repo}`,
  summary: summary(s),
  billableMinEst: 0,
  regression: null,
  successDrop: null,
  sparkline: [],
  ...extra,
});

describe("pageWorkflows", () => {
  const rows = [
    wf("CI", "repo-a", { p95: 300, flakyRate: 0.1 }),
    wf("Release", "repo-a", { p95: null }),
    wf("CI", "repo-b", {
      p95: 900,
      success: 5,
      failure: 10,
      successRate: 0.33,
    }),
    wf(
      "Nightly",
      "repo-c",
      { p95: 600 },
      {
        regression: { ratio: 1.6, recentP95: 600, baselineP95: 375 } as never,
      },
    ),
  ];
  const base = {
    sort: "p95" as const,
    dir: "desc" as const,
    page: 1,
    size: 25,
  };

  it("sorts by p95 with nulls last (the 'Slowest p95' quick view)", () => {
    expect(
      pageWorkflows(rows, base).rows.map(
        (w) => `${w.repoFullName}:${w.workflowName}`,
      ),
    ).toEqual([
      "example-org/repo-b:CI",
      "example-org/repo-c:Nightly",
      "example-org/repo-a:CI",
      "example-org/repo-a:Release",
    ]);
  });

  it("applies the chips, the repo filter and the search", () => {
    const names = (f: Parameters<typeof pageWorkflows>[1]) =>
      pageWorkflows(rows, f).rows.map(
        (w) => `${w.repositoryId}:${w.workflowName}`,
      );
    expect(names({ ...base, filters: ["flaky"] })).toEqual(["repo-a:CI"]);
    expect(names({ ...base, filters: ["lowSuccess"] })).toEqual(["repo-b:CI"]);
    expect(names({ ...base, filters: ["regressed"] })).toEqual([
      "repo-c:Nightly",
    ]);
    expect(names({ ...base, repositoryId: "repo-a" })).toEqual([
      "repo-a:CI",
      "repo-a:Release",
    ]);
    expect(names({ ...base, q: "repo-c" })).toEqual(["repo-c:Nightly"]);
  });
});

const runner = (
  name: string,
  online: boolean,
  busy: boolean,
  jobs = 0,
): RunnerDto =>
  ({
    key: `2002:ORG:${name}`,
    scope: "ORG",
    repository: null,
    githubRunnerId: "1",
    name,
    os: "Linux",
    labels: ["linux", "self-hosted"],
    groupName: null,
    online,
    busy,
    ephemeral: false,
    firstSeenAt: "2026-11-01T00:00:00.000Z",
    lastSeenAt: "2026-11-12T00:00:00.000Z",
    lastOnlineAt: null,
    jobs7d: jobs,
    failures7d: 0,
    infraFailures7d: 0,
    utilisation7d: { value: null } as never,
    speedIndex7d: null,
  }) as RunnerDto;

describe("pageRunners", () => {
  const rows = [
    runner("runner-1", true, true, 5),
    runner("runner-2", true, false, 9),
    runner("runner-3", false, false, 1),
  ];

  it("filters by state and sorts by jobs", () => {
    expect(runnerState(rows[2]!)).toBe("offline");
    const page = pageRunners(rows, {
      sort: "jobs",
      dir: "desc",
      page: 1,
      size: 25,
      filters: ["busy", "idle"],
    });
    expect(page.rows.map((r) => r.name)).toEqual(["runner-2", "runner-1"]);
    expect(
      pageRunners(rows, {
        sort: "name",
        dir: "asc",
        page: 1,
        size: 25,
        q: "self-hosted",
      }).total,
    ).toBe(3);
  });
});

describe("pageQueueGroups", () => {
  const g = (
    labelKey: string,
    oldest: number,
    stuck: number,
  ): QueueGroupDto => ({
    labelKey,
    labels: labelKey.split(","),
    repositoryId: "201",
    repoFullName: "example-org/repo-a",
    count: 1,
    oldestAgeS: oldest,
    p95AgeS: null,
    workflows: ["CI"],
    stuck,
    noMatchingRunner: false,
  });
  it("shows the oldest first and filters stuck groups", () => {
    const rows = [g("ubuntu-latest", 60, 0), g("linux,self-hosted", 1800, 2)];
    expect(
      pageQueueGroups(rows, { sort: "age", dir: "desc", page: 1, size: 25 })
        .rows[0]!.labelKey,
    ).toBe("linux,self-hosted");
    expect(
      pageQueueGroups(rows, {
        sort: "age",
        dir: "desc",
        page: 1,
        size: 25,
        filters: ["stuck"],
      }).total,
    ).toBe(1);
  });
});

describe("cost repository rows", () => {
  const costs = {
    byRepo: [
      {
        repositoryFullName: "example-org/repo-a",
        billedQuantity: 100,
        grossUsd: 10,
        netUsd: 2,
        estMin: 90,
        estUsd: 14,
      },
      {
        repositoryFullName: "example-org/repo-b",
        billedQuantity: 50,
        grossUsd: 5,
        netUsd: 5,
        estMin: 50,
        estUsd: 5,
      },
      {
        repositoryFullName: "",
        billedQuantity: 0,
        grossUsd: 1,
        netUsd: 1,
        estMin: 0,
        estUsd: 0,
      },
    ],
    reconciliation: [
      {
        repositoryFullName: "example-org/repo-a",
        sku: "linux",
        estUsd: 14,
        billedGrossUsd: 10,
        estMin: 90,
        billedQuantity: 100,
        deviation: 0.4,
        flagged: true,
      },
      {
        repositoryFullName: "example-org/repo-b",
        sku: "linux",
        estUsd: 5,
        billedGrossUsd: 5,
        estMin: 50,
        billedQuantity: 50,
        deviation: 0,
        flagged: false,
      },
    ],
  } as unknown as Costs;

  it("merges the estimate check and filters flagged rows", () => {
    const rows = costRepoRows(costs);
    expect(rows[0]).toMatchObject({ billedGrossUsd: 10, flagged: true });
    expect(rows[0]!.deviation).toBeCloseTo(0.4);
    const flagged = pageCostRepos(rows, {
      sort: "net",
      dir: "desc",
      page: 1,
      size: 10,
      filters: ["flagged"],
    });
    expect(flagged.rows.map((r) => r.repositoryFullName)).toEqual([
      "example-org/repo-a",
    ]);
    expect(
      pageCostRepos(rows, {
        sort: "net",
        dir: "desc",
        page: 1,
        size: 10,
      }).rows.map((r) => r.netUsd),
    ).toEqual([5, 2, 1]);
  });
});
