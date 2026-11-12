import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  aggregateUsageItems,
  attributeToWorkflows,
  BillingFormatError,
  daysInMonth,
  elapsedDays,
  includedMinutes,
  isActionsProduct,
  isMinutesUnit,
  parseUsageReport,
  projectMonth,
  reconcileEstimates,
  skuKeyOf,
} from "./billing";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../test/fixtures/github/${name}`, import.meta.url),
      "utf8",
    ),
  ) as unknown;

describe("billing usage parsing", () => {
  it("parses the organisation report and skips malformed items", () => {
    const { items, skipped } = parseUsageReport(
      fixture("billing-usage-org.json"),
    );
    expect(skipped).toBe(1);
    expect(items).toHaveLength(5);
    expect(items[0]).toEqual({
      date: "2026-11-02",
      product: "actions",
      sku: "Actions Linux",
      repositoryFullName: "example-org/repo-b",
      unitType: "Minutes",
      quantity: 120,
      pricePerUnit: 0.008,
      grossAmount: 0.96,
      discountAmount: 0.96,
      netAmount: 0,
    });
    // A repository name without its owner is qualified with the organisation.
    expect(items[2]!.repositoryFullName).toBe("example-org/repo-c");
    // Items without a repository keep "".
    expect(items[4]!.repositoryFullName).toBe("");
    const net = items.reduce((s, i) => s + i.netAmount, 0);
    expect(net).toBeCloseTo(0.5 + 2.4 + 0.00016801 + 1, 8);
  });

  it("parses the user report (no organizationName)", () => {
    const { items } = parseUsageReport(fixture("billing-usage-user.json"));
    expect(items.map((i) => [i.date, i.sku, i.netAmount])).toEqual([
      ["2026-11-05", "Actions Linux", 0],
      ["2026-11-06", "Actions Windows", 0.5],
    ]);
  });

  it("accepts numeric strings and rejects a body without usageItems", () => {
    const { items } = parseUsageReport({
      usageItems: [
        {
          date: "2026-11-01",
          product: "Actions",
          sku: "Actions Linux",
          quantity: "10",
          unitType: "Minutes",
          pricePerUnit: "0.008",
          grossAmount: "0.08",
          discountAmount: "0",
          netAmount: "0.08",
        },
      ],
    });
    expect(items[0]!.quantity).toBe(10);
    expect(() => parseUsageReport({ message: "Not Found" })).toThrow(
      BillingFormatError,
    );
  });

  it("aggregates rows with the same key", () => {
    const { items } = parseUsageReport(fixture("billing-usage-org.json"));
    const twice = aggregateUsageItems([...items, ...items]);
    expect(twice).toHaveLength(items.length);
    expect(twice[0]!.quantity).toBe(240);
  });

  it("classifies products, units and SKUs", () => {
    expect(isActionsProduct("Actions")).toBe(true);
    expect(isActionsProduct("Packages")).toBe(false);
    expect(isMinutesUnit("Minutes")).toBe(true);
    expect(isMinutesUnit("GigabyteHours")).toBe(false);
    expect(skuKeyOf("Actions Linux")).toBe("linux");
    expect(skuKeyOf("Actions macOS 3-core")).toBe("macos");
    expect(skuKeyOf("Actions Linux 4-core")).toBe("linux_4_core");
    expect(skuKeyOf("actions_linux_16_core")).toBe("linux_16_core");
    expect(skuKeyOf("Actions Windows")).toBe("windows");
  });
});

describe("included vs used and projection", () => {
  it("uses the override, else the plan default", () => {
    expect(includedMinutes(null, "free")).toBe(2_000);
    expect(includedMinutes(null, "Pro")).toBe(3_000);
    expect(includedMinutes(null, "team")).toBe(3_000);
    expect(includedMinutes(null, "enterprise")).toBe(50_000);
    expect(includedMinutes(null, null)).toBe(2_000);
    expect(includedMinutes(1_234, "pro")).toBe(1_234);
  });

  it("projects MTD + MTD / elapsed × remaining", () => {
    expect(projectMonth(100, 10, 30)).toBe(300);
    expect(projectMonth(100, 30, 30)).toBe(100);
    expect(projectMonth(0, 0, 30)).toBe(0);
  });

  it("counts elapsed days in UTC", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(elapsedDays(2026, 11, new Date("2026-11-12T08:00:00Z"))).toBe(12);
    expect(elapsedDays(2026, 10, new Date("2026-11-12T08:00:00Z"))).toBe(31);
    expect(elapsedDays(2026, 12, new Date("2026-11-12T08:00:00Z"))).toBe(0);
  });
});

describe("attribution and reconciliation", () => {
  it("scales per-workflow estimates to the billed minutes of their cell", () => {
    const rows = attributeToWorkflows(
      [
        {
          repositoryFullName: "example-org/repo-b",
          sku: "linux",
          workflowId: 1n,
          estMin: 60,
          estUsd: 0.48,
        },
        {
          repositoryFullName: "example-org/repo-b",
          sku: "linux",
          workflowId: 2n,
          estMin: 40,
          estUsd: 0.32,
        },
        {
          repositoryFullName: "example-org/repo-c",
          sku: "linux",
          workflowId: 3n,
          estMin: 10,
          estUsd: 0.08,
        },
      ],
      [
        {
          repositoryFullName: "example-org/repo-b",
          sku: "linux",
          quantity: 120,
          grossAmount: 0.96,
          netAmount: 0.5,
        },
      ],
    );
    expect(rows[0]).toMatchObject({ scale: 1.2, scaledMin: 72 });
    expect(rows[0]!.scaledNetUsd).toBeCloseTo(0.3);
    expect(rows[1]!.scaledNetUsd).toBeCloseTo(0.2);
    // Nothing billed for repo-c: no scale.
    expect(rows[2]).toMatchObject({ scale: null, scaledMin: null });
  });

  it("flags estimate vs billed deviations above 15%", () => {
    const rows = reconcileEstimates(
      [
        { repositoryFullName: "r/a", sku: "linux", estMin: 100, estUsd: 0.8 },
        { repositoryFullName: "r/b", sku: "linux", estMin: 100, estUsd: 0.8 },
        { repositoryFullName: "r/c", sku: "linux", estMin: 100, estUsd: 0.8 },
      ],
      [
        {
          repositoryFullName: "r/a",
          sku: "linux",
          quantity: 105,
          grossAmount: 0.84,
          netAmount: 0,
        },
        {
          repositoryFullName: "r/b",
          sku: "linux",
          quantity: 200,
          grossAmount: 1.6,
          netAmount: 0,
        },
        {
          repositoryFullName: "r/d",
          sku: "linux_4_core",
          quantity: 10,
          grossAmount: 0.16,
          netAmount: 0.16,
        },
      ],
    );
    const by = new Map(rows.map((r) => [r.repositoryFullName, r]));
    expect(by.get("r/a")!.flagged).toBe(false);
    expect(by.get("r/b")!.flagged).toBe(true);
    expect(by.get("r/b")!.deviation).toBeCloseTo(-0.5);
    // Estimated but never billed, and billed but never estimated: both flagged.
    expect(by.get("r/c")!.flagged).toBe(true);
    expect(by.get("r/d")!.flagged).toBe(true);
  });
});
