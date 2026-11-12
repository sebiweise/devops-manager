import { describe, expect, it } from "vitest";
import type { RunnerDto } from "@/server/data/runners";
import { emptyHistogram, bucketOf } from "@/server/metrics/histogram";
import {
  bandShares,
  DURATION_BANDS,
  groupRunners,
  heatmapGrid,
  intensity,
  parseRunnerKey,
  runnerCounts,
  runnerHref,
  runnerState,
  statusSegments,
} from "./runners-view";

const runner = (r: Partial<RunnerDto>): RunnerDto => ({
  key: "1:REPO:7",
  scope: "REPO",
  repository: { id: "10", fullName: "example-org/repo-a" },
  githubRunnerId: "7",
  name: "runner-1",
  os: "Linux",
  labels: ["self-hosted", "linux"],
  groupName: null,
  online: true,
  busy: false,
  ephemeral: false,
  firstSeenAt: "2026-11-01T00:00:00.000Z",
  lastSeenAt: "2026-11-11T12:00:00.000Z",
  lastOnlineAt: "2026-11-11T12:00:00.000Z",
  jobs7d: 0,
  failures7d: 0,
  infraFailures7d: 0,
  utilisation7d: {
    busyS: 0,
    onlineS: 0,
    windowS: 604_800,
    coverage: 0,
    value: null,
    insufficientSamples: true,
    medianSampleIntervalS: null,
  },
  speedIndex7d: null,
  ...r,
});

describe("runner state and grouping", () => {
  it("derives busy, idle and offline", () => {
    expect(runnerState({ online: true, busy: true })).toBe("busy");
    expect(runnerState({ online: true, busy: false })).toBe("idle");
    expect(runnerState({ online: false, busy: true })).toBe("offline");
  });

  it("puts org runners first, then repo runners grouped by repository", () => {
    const groups = groupRunners([
      runner({
        key: "1:REPO:2",
        name: "runner-b",
        repository: { id: "2", fullName: "example-org/repo-b" },
      }),
      runner({ key: "1:ORG:3", scope: "ORG", repository: null, name: "org-2" }),
      runner({ key: "1:REPO:1", name: "runner-a" }),
      runner({ key: "1:ORG:4", scope: "ORG", repository: null, name: "org-1" }),
    ]);
    expect(groups.map((g) => g.repoFullName)).toEqual([
      null,
      "example-org/repo-a",
      "example-org/repo-b",
    ]);
    expect(groups[0]!.runners.map((r) => r.name)).toEqual(["org-1", "org-2"]);
  });

  it("counts runners per state", () => {
    expect(
      runnerCounts([
        runner({ busy: true }),
        runner({}),
        runner({ online: false }),
      ]),
    ).toEqual({ total: 3, busy: 1, idle: 1, offline: 1 });
  });

  it("encodes and validates the runner key of the detail URL", () => {
    const href = runnerHref("/o/example-org", "12:REPO:345");
    expect(href).toBe("/o/example-org/runners/12%3AREPO%3A345");
    expect(parseRunnerKey("12%3AREPO%3A345")).toBe("12:REPO:345");
    expect(parseRunnerKey("12:ORG:9")).toBe("12:ORG:9");
    expect(parseRunnerKey("12:OTHER:9")).toBeNull();
    expect(parseRunnerKey("%E0%A4%A")).toBeNull();
    expect(parseRunnerKey("1:REPO:2; DROP")).toBeNull();
  });
});

describe("heatmap", () => {
  it("places weekday 1..7 and hour 0..23 and tracks the maximum", () => {
    const g = heatmapGrid([
      { weekday: 1, hour: 0, jobs: 2, queueP95: 30 },
      { weekday: 7, hour: 23, jobs: 1, queueP95: 120 },
      { weekday: 8, hour: 1, jobs: 1, queueP95: 999 },
    ]);
    expect(g.cells).toHaveLength(7);
    expect(g.cells[0]![0]).toEqual({ jobs: 2, queueP95: 30 });
    expect(g.cells[6]![23]).toEqual({ jobs: 1, queueP95: 120 });
    expect(g.maxQueueP95).toBe(120);
  });

  it("maps values to intensity steps 1..4, empty to 0", () => {
    expect(intensity(null, 100)).toBe(0);
    expect(intensity(0, 100)).toBe(1);
    expect(intensity(10, 100)).toBe(1);
    expect(intensity(60, 100)).toBe(3);
    expect(intensity(100, 100)).toBe(4);
    expect(intensity(5, 0)).toBe(0);
  });
});

describe("status segments", () => {
  const from = Date.parse("2026-11-11T00:00:00Z");
  const to = from + 4 * 600_000;
  const at = (min: number) => new Date(from + min * 60_000).toISOString();

  it("merges adjacent samples of one state and leaves gaps empty", () => {
    const segs = statusSegments(
      [
        { t: at(10), online: true, busy: true, intervalS: 600 },
        { t: at(20), online: true, busy: true, intervalS: 600 },
        { t: at(40), online: false, busy: false, intervalS: 600 },
        { t: at(41), online: true, busy: false, intervalS: 0 },
      ],
      from,
      to,
    );
    expect(segs).toEqual([
      { kind: "busy", from: 0, to: 0.5 },
      { kind: "offline", from: 0.75, to: 1 },
    ]);
  });

  it("clips samples to the window", () => {
    const segs = statusSegments(
      [{ t: at(5), online: true, busy: false, intervalS: 1200 }],
      from,
      to,
    );
    expect(segs).toEqual([{ kind: "idle", from: 0, to: 5 / 40 }]);
  });
});

describe("duration bands", () => {
  it("collapses the histogram into shares per band", () => {
    const h = emptyHistogram();
    h[bucketOf(30)]! += 2; // < 1 min
    h[bucketOf(600)]! += 1; // 5-15 min
    h[bucketOf(7200)]! += 1; // > 1 h
    const shares = bandShares(h);
    expect(shares).toHaveLength(DURATION_BANDS.length);
    expect(shares[0]).toBeCloseTo(0.5);
    expect(shares[2]).toBeCloseTo(0.25);
    expect(shares[5]).toBeCloseTo(0.25);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("returns zeros for an empty histogram", () => {
    expect(bandShares(emptyHistogram()).every((s) => s === 0)).toBe(true);
  });
});
