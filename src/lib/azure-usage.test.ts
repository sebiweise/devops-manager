import { describe, expect, it } from "vitest";
import {
  billingMonth,
  githubEquivalent,
  limitDay,
  projectWindow,
  quotaLevel,
  runWarning,
  sweepIntervals,
  usageNote,
} from "./azure-usage";
import {
  azureAsRunStatus,
  azureBadgeKind,
  azureOperations,
  azureResultText,
  pipelineSummary,
  stageRetryable,
} from "./azure-view";

describe("billing month", () => {
  it("uses the calendar month by default and a custom reset day", () => {
    expect(billingMonth("2026-11-13", 1)).toMatchObject({
      key: "2026-11",
      startDay: "2026-11-01",
      endDay: "2026-12-01",
      totalDays: 30,
      elapsedDays: 13,
      daysLeft: 18,
    });
    expect(billingMonth("2026-11-13", 15)).toMatchObject({
      key: "2026-10",
      startDay: "2026-10-15",
      endDay: "2026-11-15",
    });
    expect(billingMonth("2026-12-20", 15)).toMatchObject({
      startDay: "2026-12-15",
      endDay: "2027-01-15",
    });
    expect(billingMonth("2027-01-03", 15)).toMatchObject({
      startDay: "2026-12-15",
    });
  });
});

describe("parallel sweep", () => {
  it("finds the peak and the saturated seconds", () => {
    const s = (m: number) => m * 60_000;
    const r = sweepIntervals(
      [
        { start: s(0), end: s(10) },
        { start: s(5), end: s(15) },
        { start: s(15), end: s(20) },
      ],
      1,
      0,
      s(60),
    );
    expect(r.peak).toBe(2);
    expect(r.saturatedS).toBe(20 * 60);
    expect(
      sweepIntervals(
        [
          { start: s(0), end: s(10) },
          { start: s(5), end: s(15) },
        ],
        2,
        0,
        s(60),
      ).saturatedS,
    ).toBe(5 * 60);
  });

  it("clips intervals to the day", () => {
    expect(
      sweepIntervals([{ start: -60_000, end: 60_000 }], 1, 0, 86_400_000)
        .saturatedS,
    ).toBe(60);
  });
});

describe("quota", () => {
  const w = billingMonth("2026-11-13", 1);
  it("projects and finds the day the limit is reached", () => {
    expect(projectWindow(1300, w)).toBeCloseTo(3000);
    expect(limitDay(1300, 1800, w)).toBe("2026-11-18");
    expect(limitDay(100, 1800, w)).toBeNull();
  });

  it("warns at 80 % or a projection over the limit, exceeds at 100 %", () => {
    expect(quotaLevel(1440, 1800, 1500, 18)).toBe("warning");
    expect(quotaLevel(1000, 1800, 2300, 18)).toBe("warning");
    expect(quotaLevel(1000, 1800, 2300, 5)).toBe("ok");
    expect(quotaLevel(1800, 1800, 1800, 18)).toBe("exceeded");
    expect(quotaLevel(5000, null, 9000, 18)).toBe("unlimited");
  });

  it("notes API and estimate when they differ by more than 5 %", () => {
    expect(usageNote(1000, 1040)).toMatchObject({
      shown: 1000,
      source: "api",
      differs: false,
    });
    expect(usageNote(1000, 1100)).toMatchObject({ differs: true });
    expect(usageNote(null, 742)).toMatchObject({
      shown: 742,
      source: "estimate",
    });
  });

  it("warns before a run that may not fit", () => {
    expect(
      runWarning({ minutesLeft: 20, p90Minutes: 30, maxJobMinutes: 60 }),
    ).toEqual({ quota: true, jobCap: false });
    expect(
      runWarning({ minutesLeft: 200, p90Minutes: 55, maxJobMinutes: 60 }),
    ).toEqual({ quota: false, jobCap: true });
    expect(
      runWarning({ minutesLeft: null, p90Minutes: 30, maxJobMinutes: 360 }),
    ).toEqual({ quota: false, jobCap: false });
  });

  it("counts Azure macOS minutes the GitHub way (× the SkuRate multiplier)", () => {
    expect(githubEquivalent(100, 10, 0.08)).toEqual({ minutes: 1000, usd: 8 });
  });
});

describe("view helpers", () => {
  it("shows partially succeeded as its own amber state", () => {
    expect(azureBadgeKind("COMPLETED", "PARTIALLY_SUCCEEDED")).toBe("partial");
    expect(azureBadgeKind("COMPLETED", "FAILED", true)).toBe("TIMED_OUT");
    expect(azureBadgeKind("NOT_STARTED", "NONE")).toBe("QUEUED");
    expect(azureAsRunStatus("COMPLETED", "PARTIALLY_SUCCEEDED")).toEqual({
      status: "COMPLETED",
      conclusion: "PARTIAL",
    });
    expect(azureAsRunStatus("POSTPONED", "NONE")).toEqual({
      status: "WAITING",
      conclusion: null,
    });
  });

  it("offers cancel while open and retry after a failure", () => {
    expect(azureOperations({ status: "IN_PROGRESS", result: "NONE" })).toEqual([
      "cancel",
    ]);
    expect(
      azureOperations({ status: "COMPLETED", result: "PARTIALLY_SUCCEEDED" }),
    ).toEqual(["retry"]);
    expect(
      azureOperations({ status: "COMPLETED", result: "SUCCEEDED" }),
    ).toEqual([]);
    expect(
      stageRetryable(
        { status: "COMPLETED" },
        { state: "completed", result: "FAILED" },
      ),
    ).toBe(true);
    expect(
      stageRetryable(
        { status: "IN_PROGRESS" },
        { state: "completed", result: "FAILED" },
      ),
    ).toBe(false);
  });

  it("counts partial and timed out in the success denominator", () => {
    const s = pipelineSummary([
      {
        builds: 10,
        succeeded: 6,
        partial: 1,
        failed: 1,
        canceled: 1,
        timedOut: 1,
        firstTrySuccess: 5,
        flakyRecovered: 1,
        durationHist: null,
        queueHist: null,
        jobSecondsHostedMacos: 600,
        jobSecondsHostedLinux: 1800,
      },
    ]);
    expect(s.successRate).toBeCloseTo(6 / 9);
    expect(s.macosShare).toBeCloseTo(0.25);
    expect(s.hostedMinutes).toBe(40);
  });

  it("names the result of settings and actions", () => {
    expect(
      azureResultText({ status: "failed", message: "outcome_unknown: socket" })
        .key,
    ).toBe("ci.azure.result.outcomeUnknown");
    expect(
      azureResultText({ status: "failed", message: "scope_missing_pools" }).key,
    ).toBe("ci.azure.settings.errors.scope_missing_pools");
    expect(
      azureResultText({ status: "unavailable", reason: "azure_rate_limited" })
        .key,
    ).toBe("ci.azure.actions.unavailable.azure_rate_limited");
    expect(
      azureResultText({ status: "refused", reason: "quota_exhausted" }).key,
    ).toBe("ci.azure.actions.refused.quota_exhausted");
  });
});
