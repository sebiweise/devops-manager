import { describe, expect, it } from "vitest";
import {
  adjacentMonths,
  credentialFixable,
  currentMonth,
  gaugeGeometry,
} from "./costs-view";

const included = (v: {
  included: number;
  used: number;
  projectedUsed: number;
}) => ({
  ...v,
  usedSource: "billed" as const,
  projectedNetUsd: 0,
  elapsedDays: 10,
  daysInMonth: 30,
});

describe("month navigation", () => {
  it("steps across year boundaries", () => {
    expect(adjacentMonths("2026-01")).toEqual({
      prev: "2025-12",
      next: "2026-02",
    });
    expect(adjacentMonths("2026-12")).toEqual({
      prev: "2026-11",
      next: "2027-01",
    });
    expect(currentMonth(new Date("2026-11-12T08:00:00Z"))).toBe("2026-11");
  });
});

describe("gaugeGeometry", () => {
  it("scales to the included minutes while used and projected fit", () => {
    const g = gaugeGeometry(
      included({ included: 2000, used: 500, projectedUsed: 1500 }),
    );
    expect(g.usedPct).toBe(25);
    expect(g.projectedPct).toBe(75);
    expect(g.includedPct).toBe(100);
    expect(g.usedOfIncluded).toBe(0.25);
    expect(g.overIncluded).toBe(false);
    expect(g.projectedOverIncluded).toBe(false);
  });

  it("rescales when the projection exceeds the included minutes", () => {
    const g = gaugeGeometry(
      included({ included: 2000, used: 1000, projectedUsed: 4000 }),
    );
    expect(g.projectedPct).toBe(100);
    expect(g.includedPct).toBe(50);
    expect(g.usedPct).toBe(25);
    expect(g.projectedOverIncluded).toBe(true);
  });

  it("flags usage above the included minutes", () => {
    const g = gaugeGeometry(
      included({ included: 2000, used: 2500, projectedUsed: 2500 }),
    );
    expect(g.overIncluded).toBe(true);
    expect(g.usedPct).toBe(100);
  });

  it("handles zero included minutes", () => {
    const g = gaugeGeometry(
      included({ included: 0, used: 0, projectedUsed: 0 }),
    );
    expect(g.usedOfIncluded).toBeNull();
    expect(Number.isNaN(g.usedPct)).toBe(false);
  });
});

describe("credentialFixable", () => {
  it("links to /admin/github only for personal accounts without a working credential", () => {
    expect(credentialFixable("no_credential", "USER")).toBe(true);
    expect(credentialFixable("credential_error", "USER")).toBe(true);
    expect(credentialFixable("no_permission", "ORGANIZATION")).toBe(false);
    expect(credentialFixable("no_credential", "ORGANIZATION")).toBe(false);
    expect(credentialFixable(null, "USER")).toBe(false);
  });
});
