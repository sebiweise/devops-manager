import { describe, expect, it } from "vitest";
import {
  busySeconds,
  compareHostedSelfHosted,
  concurrencyTimeline,
  isInfraFailure,
  labelsSatisfy,
  medianSampleInterval,
  nextSampleInterval,
  onlineSeconds,
  peakConcurrency,
  queueFlags,
  speedIndex,
  unionSeconds,
  utilisation,
  type QueueRunner,
  type SampleRow,
} from "./runners";

const T0 = Date.parse("2026-11-10T00:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000);
const HOUR = { from: T0, to: T0 + 3_600_000 };

describe("interval union", () => {
  it("merges overlapping intervals and clips them to the window", () => {
    const s = unionSeconds(
      [
        { start: T0 - 600_000, end: T0 + 600_000 }, // 10 min inside
        { start: T0 + 300_000, end: T0 + 900_000 }, // overlaps: +5 min
        { start: T0 + 1_800_000, end: T0 + 2_400_000 }, // 10 min
      ],
      HOUR,
    );
    expect(s).toBe(25 * 60);
  });

  it("does not count a job twice when samples also cover it", () => {
    const samples: SampleRow[] = [
      { sampledAt: at(10), online: true, busy: true, intervalS: 600 },
    ];
    const jobs = [{ startedAt: at(5), completedAt: at(15) }];
    // samples cover 0..10, the job 5..15: union 0..15
    expect(onlineSeconds(samples, jobs, HOUR)).toBe(15 * 60);
    expect(busySeconds(jobs, HOUR)).toBe(10 * 60);
  });

  it("ignores offline samples and first samples without an interval", () => {
    const samples: SampleRow[] = [
      { sampledAt: at(10), online: true, busy: false, intervalS: 0 },
      { sampledAt: at(20), online: false, busy: false, intervalS: 600 },
    ];
    expect(onlineSeconds(samples, [], HOUR)).toBe(0);
  });
});

describe("utilisation and sample coverage", () => {
  it("reports busy / online when samples cover at least half the window", () => {
    const u = utilisation(900, 2_400, 3_600);
    expect(u.insufficientSamples).toBe(false);
    expect(u.value).toBeCloseTo(0.375);
    expect(u.coverage).toBeCloseTo(2 / 3);
  });

  it('says "insufficient samples" below 50% coverage', () => {
    const u = utilisation(600, 1_700, 3_600);
    expect(u.coverage).toBeLessThan(0.5);
    expect(u.insufficientSamples).toBe(true);
    expect(u.value).toBeNull();
  });

  it("is exactly at the threshold sufficient", () => {
    expect(utilisation(0, 1_800, 3_600).insufficientSamples).toBe(false);
  });

  it("caps utilisation at 1", () => {
    expect(utilisation(5_000, 3_600, 3_600).value).toBe(1);
  });

  it("derives sample coverage from 10-minute samples over a week", () => {
    const week = { from: T0, to: T0 + 7 * 86_400_000 };
    // Sampled every 10 min for 3 days only: coverage 3/7 < 50%.
    const samples: SampleRow[] = [];
    for (let m = 10; m <= 3 * 24 * 60; m += 10)
      samples.push({
        sampledAt: at(m),
        online: true,
        busy: false,
        intervalS: m === 10 ? 0 : 600,
      });
    const online = onlineSeconds(samples, [], week);
    const u = utilisation(0, online, 7 * 86_400);
    expect(u.insufficientSamples).toBe(true);
    expect(medianSampleInterval(samples)).toBe(600);
  });

  it("caps the interval of a new sample at twice the target", () => {
    expect(nextSampleInterval(null, at(10), 600)).toBe(0);
    expect(nextSampleInterval(at(0), at(10), 600)).toBe(600);
    expect(nextSampleInterval(at(0), at(600), 600)).toBe(1_200);
  });
});

describe("live queue flags", () => {
  const now = T0 + 60 * 60_000;
  const job = (labels: string[], ageMin: number, repositoryId = 11n) => ({
    repositoryId,
    labels,
    createdAt: new Date(now - ageMin * 60_000),
    waitingS: 0,
  });
  const runner = (r: Partial<QueueRunner>): QueueRunner => ({
    scope: "REPO",
    repositoryId: 11n,
    labels: ["self-hosted", "linux", "x64"],
    online: true,
    busy: false,
    removedAt: null,
    ...r,
  });

  it("marks a self-hosted job queued > 15 min without a free runner as STUCK", () => {
    const flags = queueFlags(
      job(["self-hosted", "linux"], 20),
      [runner({ busy: true })],
      now,
    );
    expect(flags).toMatchObject({ stuck: true, noMatchingRunner: false });
  });

  it("is not STUCK while a free online runner with matching labels exists", () => {
    expect(
      queueFlags(job(["self-hosted", "Linux"], 20), [runner({})], now).stuck,
    ).toBe(false);
  });

  it("is not STUCK before 15 minutes", () => {
    expect(
      queueFlags(job(["self-hosted"], 10), [runner({ online: false })], now)
        .stuck,
    ).toBe(false);
  });

  it("flags no matching runner when no runner has all the labels", () => {
    const flags = queueFlags(
      job(["self-hosted", "gpu"], 30),
      [runner({ online: false })],
      now,
    );
    expect(flags).toMatchObject({ stuck: true, noMatchingRunner: true });
  });

  it("ignores repo runners of other repositories and removed runners", () => {
    const flags = queueFlags(
      job(["self-hosted"], 30),
      [runner({ repositoryId: 22n }), runner({ removedAt: at(0) })],
      now,
    );
    expect(flags.noMatchingRunner).toBe(true);
    // An org runner serves every repository.
    expect(
      queueFlags(
        job(["self-hosted"], 30),
        [runner({ scope: "ORG", repositoryId: null })],
        now,
      ).stuck,
    ).toBe(false);
  });

  it("never flags hosted jobs", () => {
    expect(queueFlags(job(["ubuntu-latest"], 120), [], now)).toMatchObject({
      stuck: false,
      noMatchingRunner: false,
    });
  });

  it("excludes the approval wait from the STUCK age", () => {
    const j = { ...job(["self-hosted"], 20), waitingS: 10 * 60 };
    expect(queueFlags(j, [], now).stuck).toBe(false);
  });

  it("compares labels case-insensitively as a superset", () => {
    expect(labelsSatisfy(["Self-Hosted", "Linux", "X64"], ["linux"])).toBe(
      true,
    );
    expect(labelsSatisfy(["self-hosted"], ["self-hosted", "linux"])).toBe(
      false,
    );
  });
});

describe("concurrency", () => {
  it("counts running and queued jobs per 5-minute bucket", () => {
    const jobs = [
      { createdAt: at(0), startedAt: at(2), completedAt: at(12), waitingS: 0 },
      { createdAt: at(1), startedAt: at(5), completedAt: at(10), waitingS: 0 },
    ];
    const buckets = concurrencyTimeline(jobs, {
      from: T0,
      to: T0 + 15 * 60_000,
    });
    expect(buckets).toHaveLength(3);
    expect(buckets[0]).toMatchObject({ running: 0, queued: 1 });
    expect(buckets[1]).toMatchObject({ running: 2, queued: 0 });
    expect(buckets[0]!.runningAvg).toBeCloseTo(3 / 5);
    expect(buckets[2]!.running).toBe(1);
  });

  it("finds the peak; back-to-back jobs do not overlap", () => {
    expect(
      peakConcurrency([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 5, end: 15 },
      ]),
    ).toBe(2);
  });
});

describe("speed index, infra failures, hosted vs self-hosted", () => {
  const jobs = (runnerKey: string, durations: number[]) =>
    durations.map((durationS) => ({
      workflowId: 1n,
      baseName: "test",
      runnerKey,
      durationS,
    }));

  it("is the median ratio against all runners (0.8 = 20% faster)", () => {
    const all = [
      ...jobs("sh:runner-1", [80, 80, 80, 80, 80]),
      ...jobs("sh:runner-2", [120, 120, 120, 120, 120]),
    ];
    // median of all = 100 (interpolated between 80 and 120)
    expect(speedIndex(all, "sh:runner-1")).toBeCloseTo(0.8);
    expect(speedIndex(all, "sh:runner-2")).toBeCloseTo(1.2);
  });

  it("needs five jobs on the runner and two runners overall", () => {
    expect(
      speedIndex(jobs("sh:runner-1", [1, 2, 3, 4, 5]), "sh:runner-1"),
    ).toBeNull();
    const few = [
      ...jobs("sh:runner-1", [1, 2, 3, 4]),
      ...jobs("sh:runner-2", [1, 2, 3, 4, 5]),
    ];
    expect(speedIndex(few, "sh:runner-1")).toBeNull();
  });

  it("detects infra failures", () => {
    const base = {
      startedAt: at(0),
      completedAt: at(30),
    };
    expect(
      isInfraFailure({ ...base, conclusion: "FAILURE", durationS: 5 }, null),
    ).toBe(true);
    expect(
      isInfraFailure(
        { ...base, conclusion: "FAILURE", durationS: 1_800 },
        at(10),
      ),
    ).toBe(true);
    expect(
      isInfraFailure(
        { ...base, conclusion: "FAILURE", durationS: 1_800 },
        null,
      ),
    ).toBe(false);
    expect(
      isInfraFailure({ ...base, conclusion: "SUCCESS", durationS: 2 }, null),
    ).toBe(false);
  });

  it("compares hosted and self-hosted jobs with n >= 5 on both sides", () => {
    const mk = (kind: "GITHUB_HOSTED" | "SELF_HOSTED", d: number, n: number) =>
      Array.from({ length: n }, () => ({
        workflowId: 1n,
        baseName: "build",
        runnerKind: kind,
        durationS: d,
        queueS: kind === "SELF_HOSTED" ? 2 : 20,
      }));
    const rows = compareHostedSelfHosted([
      ...mk("GITHUB_HOSTED", 200, 5),
      ...mk("SELF_HOSTED", 100, 5),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deltaP50).toBeCloseTo(-0.5);
    expect(rows[0]!.selfHosted.queueP95).toBe(2);
    expect(
      compareHostedSelfHosted([
        ...mk("GITHUB_HOSTED", 200, 5),
        ...mk("SELF_HOSTED", 100, 4),
      ]),
    ).toHaveLength(0);
  });
});
