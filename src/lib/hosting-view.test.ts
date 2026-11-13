import { describe, expect, it } from "vitest";
import {
  dailyAllotment,
  deployBadgeKind,
  deploySuccessRate,
  fillDays,
  deploymentOperations,
  needsTypedName,
  quotaRatio,
  vercelActionResultText,
  vercelResultText,
} from "./hosting-view";

describe("hosting view", () => {
  it("maps states to badges", () => {
    expect(deployBadgeKind("READY")).toBe("deployReady");
    expect(deployBadgeKind("INITIALIZING")).toBe("deployBuilding");
    expect(deployBadgeKind("DELETED")).toBe("deployUnknown");
    expect(deployBadgeKind(null)).toBe("deployUnknown");
  });

  it("computes the Hobby daily allotment share", () => {
    expect(dailyAllotment("hobby")).toBe(100);
    expect(dailyAllotment("enterprise")).toBeNull();
    expect(quotaRatio(37, "hobby")).toBeCloseTo(0.37);
    expect(quotaRatio(120, "hobby")).toBeGreaterThan(1);
    expect(quotaRatio(5, null)).toBeNull();
  });

  it("fills missing days and sums projects", () => {
    const days = fillDays(
      ["2026-11-10", "2026-11-11"],
      [
        { day: "2026-11-11", total: 5, ready: 3, error: 1, canceled: 0 },
        { day: "2026-11-11", total: 2, ready: 2, error: 0, canceled: 0 },
      ],
    );
    expect(days).toEqual([
      { day: "2026-11-10", ready: 0, error: 0, canceled: 0, other: 0 },
      { day: "2026-11-11", ready: 5, error: 1, canceled: 0, other: 1 },
    ]);
    expect(deploySuccessRate(3, 1)).toBe(0.75);
    expect(deploySuccessRate(0, 0)).toBeNull();
  });

  it("names Vercel failures without blaming GitHub", () => {
    expect(
      vercelResultText({ status: "failed", message: "invalid_token" }).key,
    ).toBe("vercelSettings.errors.invalid_token");
    expect(
      vercelResultText({ status: "refused", reason: "invalid_repository" }).key,
    ).toBe("vercelSettings.errors.invalid_repository");
    expect(
      vercelResultText({ status: "failed", message: "boom" }),
    ).toMatchObject({
      key: "vercelSettings.errors.other",
      values: { code: "boom" },
    });
    expect(vercelResultText({ status: "forbidden" }).key).toBe(
      "management.result.forbidden",
    );
    expect(vercelResultText({ status: "succeeded" }).tone).toBe("success");
  });
});

describe("M6 deployment actions view", () => {
  const base = {
    state: "READY",
    target: "production",
    live: false,
    rollbackCandidate: false,
  };

  it("offers the operations each state allows", () => {
    expect(deploymentOperations({ ...base, state: "BUILDING" })).toEqual([
      "cancel",
    ]);
    expect(deploymentOperations({ ...base, state: "QUEUED" })).toEqual([
      "cancel",
    ]);
    expect(deploymentOperations({ ...base, state: "ERROR" })).toEqual([
      "redeploy",
    ]);
    expect(deploymentOperations({ ...base, live: true })).toEqual(["redeploy"]);
    // Live but paused: promote re-enables auto-assignment.
    expect(deploymentOperations({ ...base, live: true, paused: true })).toEqual(
      ["redeploy", "promote"],
    );
    expect(deploymentOperations({ ...base, rollbackCandidate: true })).toEqual([
      "redeploy",
      "promote",
      "rollback",
    ]);
    expect(deploymentOperations({ ...base, target: "preview" })).toEqual([
      "redeploy",
    ]);
    expect(deploymentOperations({ ...base, state: "DELETED" })).toEqual([]);
  });

  it("needs the typed project name for production-affecting operations", () => {
    expect(needsTypedName("redeploy", "preview")).toBe(false);
    expect(needsTypedName("redeploy", "production")).toBe(true);
    expect(needsTypedName("cancel", "production")).toBe(false);
    expect(needsTypedName("promote", "production")).toBe(true);
    expect(needsTypedName("rollback", "production")).toBe(true);
  });

  it("puts action results into words", () => {
    expect(vercelActionResultText({ status: "succeeded" }).key).toBe(
      "hosting.actions.result.succeeded",
    );
    expect(
      vercelActionResultText({
        status: "failed",
        message: "outcome_unknown: fetch failed",
      }),
    ).toMatchObject({
      key: "hosting.actions.result.outcomeUnknown",
      tone: "info",
    });
    expect(
      vercelActionResultText({ status: "failed", message: "conflict: busy" }),
    ).toEqual({
      key: "hosting.actions.result.failed",
      values: { message: "conflict: busy" },
      tone: "error",
    });
    expect(
      vercelActionResultText({
        status: "unavailable",
        reason: "vercel_management_disabled",
      }).key,
    ).toBe("hosting.actions.unavailable.vercel_management_disabled");
    expect(
      vercelActionResultText({ status: "refused", reason: "already_live" }).key,
    ).toBe("hosting.actions.refused.already_live");
    expect(
      vercelActionResultText({ status: "refused", reason: "unchanged" }).key,
    ).toBe("vercelSettings.errors.unchanged");
    expect(vercelActionResultText({ status: "forbidden" }).key).toBe(
      "management.result.forbidden",
    );
  });
});
