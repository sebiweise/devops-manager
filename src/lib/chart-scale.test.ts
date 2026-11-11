import { describe, expect, it } from "vitest";
import {
  criticalPath,
  linePath,
  niceMax,
  stack,
  ticks,
  timelineSegments,
} from "./chart-scale";

describe("scales", () => {
  it("rounds the maximum up to a nice number", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-3)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(18)).toBe(20);
    expect(niceMax(23)).toBe(25);
    expect(niceMax(420)).toBe(500);
    expect(niceMax(620.75)).toBe(1000);
  });

  it("spreads ticks evenly from zero", () => {
    expect(ticks(20)).toEqual([0, 5, 10, 15, 20]);
  });

  it("stacks positive values in series order and skips zeros", () => {
    expect(
      stack({ success: 3, failure: 0, cancelled: 2 }, [
        "success",
        "failure",
        "cancelled",
      ]),
    ).toEqual([
      { key: "success", y0: 0, y1: 3 },
      { key: "cancelled", y0: 3, y1: 5 },
    ]);
  });

  it("breaks lines at missing values instead of interpolating", () => {
    const d = linePath(
      [1, 2, null, 4],
      (i) => i * 10,
      (v) => v,
    );
    expect(d).toBe("M0,1L10,2M30,4");
  });
});

describe("timelineSegments", () => {
  it("splits a finished job into queue and execution", () => {
    expect(
      timelineSegments(
        { created: 0, waitEnd: null, started: 10, completed: 70 },
        0,
        100,
      ),
    ).toEqual([
      { kind: "queue", from: 0, to: 10 },
      { kind: "run", from: 10, to: 70 },
    ]);
  });

  it("shows an approval wait between two queue parts", () => {
    expect(
      timelineSegments(
        { created: 0, waitEnd: 50, started: 60, completed: 90 },
        40,
        100,
      ),
    ).toEqual([
      { kind: "queue", from: 0, to: 10 },
      { kind: "wait", from: 10, to: 50 },
      { kind: "queue", from: 50, to: 60 },
      { kind: "run", from: 60, to: 90 },
    ]);
  });

  it("extends running and queued jobs to now", () => {
    expect(
      timelineSegments(
        { created: 5, waitEnd: null, started: 20, completed: null },
        0,
        80,
      ),
    ).toEqual([
      { kind: "queue", from: 5, to: 20 },
      { kind: "run", from: 20, to: 80 },
    ]);
    expect(
      timelineSegments(
        { created: 5, waitEnd: null, started: null, completed: null },
        0,
        80,
      ),
    ).toEqual([{ kind: "queue", from: 5, to: 80 }]);
  });

  it("draws nothing for a job skipped without a runner", () => {
    expect(
      timelineSegments(
        { created: 0, waitEnd: null, started: 0, completed: 0 },
        0,
        100,
      ),
    ).toEqual([]);
  });
});

describe("criticalPath", () => {
  it("follows predecessors that ended at most 5 s before the next start", () => {
    const path = criticalPath([
      { id: "build", started: 0, completed: 100 },
      { id: "lint", started: 0, completed: 30 },
      { id: "test", started: 103, completed: 200 },
      { id: "docs", started: 120, completed: 150 },
      { id: "deploy", started: 204, completed: 260 },
    ]);
    expect([...path].sort()).toEqual(["build", "deploy", "test"]);
  });

  it("stops at a gap and ignores unfinished jobs", () => {
    const path = criticalPath([
      { id: "a", started: 0, completed: 10 },
      { id: "b", started: 30, completed: 50 },
      { id: "c", started: 40, completed: null },
    ]);
    expect([...path]).toEqual(["b"]);
  });

  it("is empty without finished jobs", () => {
    expect(
      criticalPath([{ id: "a", started: null, completed: null }]).size,
    ).toBe(0);
  });
});
