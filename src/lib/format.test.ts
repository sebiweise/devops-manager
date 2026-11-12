import { describe, expect, it } from "vitest";
import {
  approx,
  EMPTY,
  formatDuration,
  formatMinutes,
  formatPercent,
  formatPointsDelta,
  formatRatio,
  formatSignedPercent,
  formatUsd,
  shortSha,
} from "./format";

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [42.4, "42s"],
    [59.6, "1m 00s"],
    [303, "5m 03s"],
    [3600, "1h 00m"],
    [7500, "2h 05m"],
    [97_200, "1d 3h"],
  ])("%s s -> %s", (s, expected) => {
    expect(formatDuration(s)).toBe(expected);
  });

  it("renders missing and invalid values as a dash", () => {
    expect(formatDuration(null)).toBe(EMPTY);
    expect(formatDuration(undefined)).toBe(EMPTY);
    expect(formatDuration(-1)).toBe(EMPTY);
    expect(formatDuration(Number.NaN)).toBe(EMPTY);
  });
});

describe("rates and minutes", () => {
  it("formats rates as percentages per locale", () => {
    expect(formatPercent(0.934)).toBe("93.4%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(0.5, "de")).toBe("50 %");
    expect(formatPercent(null)).toBe(EMPTY);
  });

  it("signs percentage-point deltas", () => {
    expect(formatPointsDelta(0.021)).toBe("+2.1 pp");
    expect(formatPointsDelta(-0.1)).toBe("-10 pp");
    expect(formatPointsDelta(0)).toBe("0 pp");
    expect(formatPointsDelta(null)).toBe(EMPTY);
  });

  it("shows estimated minutes as whole minutes only", () => {
    expect(formatMinutes(55)).toBe("55 min");
    expect(formatMinutes(1234.4)).toBe("1,234 min");
    expect(formatMinutes(1234.4, "de")).toBe("1.234 min");
  });

  it("marks approximate values with ~, never the dash", () => {
    expect(approx("5m 03s", true)).toBe("~5m 03s");
    expect(approx("5m 03s", false)).toBe("5m 03s");
    expect(approx(EMPTY, true)).toBe(EMPTY);
  });

  it("shortens commit shas", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
  });
});

describe("formatUsd and formatRatio", () => {
  it("formats dollars with cents in both languages", () => {
    expect(formatUsd(1234.5, "en")).toBe("$1,234.50");
    expect(formatUsd(0, "en")).toBe("$0.00");
    expect(formatUsd(1234.5, "de")).toMatch(/^1\.234,50\s\$$/);
    expect(formatUsd(null)).toBe(EMPTY);
    expect(formatUsd(Number.NaN)).toBe(EMPTY);
  });

  it("formats signed relative changes", () => {
    expect(formatSignedPercent(0.25)).toBe("+25%");
    expect(formatSignedPercent(-0.1)).toBe("-10%");
    expect(formatSignedPercent(0)).toBe("0%");
    expect(formatSignedPercent(null)).toBe(EMPTY);
  });

  it("formats ratios with two decimals", () => {
    expect(formatRatio(0.8)).toBe("0.80");
    expect(formatRatio(1.234, "de")).toBe("1,23");
    expect(formatRatio(null)).toBe(EMPTY);
  });
});
