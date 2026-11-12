import { describe, expect, it } from "vitest";
import {
  daysBetween,
  lastDaysWindow,
  previousWindow,
  rangeWindow,
  startOfLocalDay,
} from "./days";

describe("startOfLocalDay", () => {
  it("is UTC midnight in UTC", () => {
    expect(startOfLocalDay("2026-11-12", "UTC").toISOString()).toBe(
      "2026-11-12T00:00:00.000Z",
    );
  });

  it("follows the zone's offset, also across a DST change", () => {
    // CET (UTC+1) in winter, CEST (UTC+2) in summer.
    expect(startOfLocalDay("2026-11-12", "Europe/Berlin").toISOString()).toBe(
      "2026-11-11T23:00:00.000Z",
    );
    expect(startOfLocalDay("2026-07-01", "Europe/Berlin").toISOString()).toBe(
      "2026-06-30T22:00:00.000Z",
    );
    // The day DST ends: midnight is still CEST.
    expect(startOfLocalDay("2026-10-25", "Europe/Berlin").toISOString()).toBe(
      "2026-10-24T22:00:00.000Z",
    );
    expect(
      startOfLocalDay("2026-11-12", "America/New_York").toISOString(),
    ).toBe("2026-11-12T05:00:00.000Z");
  });

  it("falls back to UTC for an unknown zone", () => {
    expect(startOfLocalDay("2026-11-12", "Not/AZone").toISOString()).toBe(
      "2026-11-12T00:00:00.000Z",
    );
  });
});

describe("rangeWindow", () => {
  const now = new Date("2026-11-12T10:30:00.000Z");

  it("7 d is today and the 6 days before: exactly 7 daily buckets", () => {
    const w = rangeWindow("7d", now, "UTC");
    expect(w).toEqual({
      from: new Date("2026-11-06T00:00:00.000Z"),
      to: now,
      fromDay: "2026-11-06",
      toDay: "2026-11-12",
    });
    expect(daysBetween(w.fromDay, w.toDay)).toHaveLength(7);
    expect(
      daysBetween(rangeWindow("30d", now, "UTC").fromDay, "2026-11-12"),
    ).toHaveLength(30);
  });

  it("raw and rollup bounds describe the same local days", () => {
    const w = rangeWindow("7d", now, "Europe/Berlin");
    expect(w.fromDay).toBe("2026-11-06");
    expect(w.from.toISOString()).toBe("2026-11-05T23:00:00.000Z");
  });

  it("24 h stays rolling", () => {
    const w = rangeWindow("24h", now, "UTC");
    expect(w.from.toISOString()).toBe("2026-11-11T10:30:00.000Z");
    expect([w.fromDay, w.toDay]).toEqual(["2026-11-11", "2026-11-12"]);
  });

  it("the previous window is the same number of days right before", () => {
    const last7 = lastDaysWindow(7, now, "UTC");
    const prev = previousWindow(last7, "UTC");
    expect(prev).toEqual({
      from: new Date("2026-10-30T00:00:00.000Z"),
      to: last7.from,
      fromDay: "2026-10-30",
      toDay: "2026-11-05",
    });
  });
});
