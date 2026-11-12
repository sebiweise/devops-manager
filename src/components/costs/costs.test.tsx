import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Costs } from "@/server/data/costs";
import en from "../../../messages/en.json";
import { CostsPerDayChart, EstimateNotice, IncludedGauge } from "./cost-charts";

/**
 * Costs building blocks (design §6.6, §7 /costs): the included gauge with
 * the projection, the per-day chart (billed or estimated) and the
 * estimate-only notice with its reason and the admin link.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
}

const costs = (c: Partial<Costs>): Costs => ({
  month: "2026-11",
  source: "billed",
  reason: null,
  adminNotice: null,
  syncedAt: "2026-11-11T03:17:00.000Z",
  totals: {
    netUsd: 12.5,
    grossUsd: 40,
    discountUsd: 27.5,
    netUsdAllProducts: 13,
    estUsd: 38,
    estMin: 4800,
  },
  included: {
    included: 3000,
    used: 1500,
    usedSource: "billed",
    projectedUsed: 4500,
    projectedNetUsd: 37.5,
    elapsedDays: 10,
    daysInMonth: 30,
  },
  bySku: [],
  byRepo: [],
  byDay: [
    {
      day: "2026-11-01",
      billedQuantity: 100,
      netUsd: 1,
      estMin: 90,
      estUsd: 0.7,
    },
    { day: "2026-11-02", billedQuantity: 0, netUsd: 0, estMin: 0, estUsd: 0 },
  ],
  byWorkflow: [],
  reconciliation: [],
  unmatchedJobs: 0,
  ...c,
});

describe("IncludedGauge", () => {
  it("states used, included and projected in the aria-label", () => {
    const html = render(<IncludedGauge costs={costs({})} />);
    expect(html).toContain(
      'aria-label="1,500 of 3,000 included minutes used; projected 4,500 by the end of the month."',
    );
    expect(html).toContain("The projection exceeds the included minutes.");
    expect(html).toContain("(10 of 30 days elapsed)");
    expect(html).toContain(">Show as table</button>");
  });

  it("marks usage above the included minutes", () => {
    const html = render(
      <IncludedGauge
        costs={costs({
          included: {
            included: 2000,
            used: 2500,
            usedSource: "estimate",
            projectedUsed: 2500,
            projectedNetUsd: 0,
            elapsedDays: 30,
            daysInMonth: 30,
          },
        })}
      />,
    );
    expect(html).toContain("Above the included minutes.");
    expect(html).toContain("bg-destructive");
    expect(html).toContain("(estimated), with the projection");
  });
});

describe("CostsPerDayChart", () => {
  it("shows billed minutes when billed", () => {
    const html = render(<CostsPerDayChart costs={costs({})} />);
    expect(html).toContain(
      'aria-label="Bar chart of Billed minutes per day in 2026-11, 100 min in total."',
    );
    expect(html).toContain("<title>2026-11-01: Billed 100</title>");
  });

  it("shows hatched estimated minutes otherwise", () => {
    const html = render(
      <CostsPerDayChart
        costs={costs({ source: "estimate", reason: "no_credential" })}
      />,
    );
    expect(html).toContain("<title>2026-11-01: Estimated 90</title>");
    expect(html).toContain("url(#costs-by-day-hatch)");
  });
});

describe("EstimateNotice", () => {
  it("is absent for billed data", () => {
    expect(
      render(<EstimateNotice costs={costs({})} accountType="ORGANIZATION" />),
    ).toBe("");
  });

  it("explains a personal account without a credential, without an error", () => {
    const html = render(
      <EstimateNotice
        costs={costs({ source: "estimate", reason: "no_credential" })}
        accountType="USER"
      />,
    );
    expect(html).toContain(
      "Costs are estimates: this personal account has no billing credential.",
    );
    // Viewers and operators get no admin link and no stored error.
    expect(html).not.toContain("/admin/github");
  });

  it("links admins to /admin/github and shows reconnect", () => {
    const html = render(
      <EstimateNotice
        costs={costs({
          source: "estimate",
          reason: "credential_error",
          adminNotice: { error: "bad_refresh_token", reconnect: true },
        })}
        accountType="USER"
      />,
    );
    expect(html).toContain('href="/admin/github"');
    expect(html).toContain("Reconnect the billing credential");
    expect(html).toContain("Last billing error: bad_refresh_token");
  });

  it("explains a missing organisation permission without a credential link", () => {
    const html = render(
      <EstimateNotice
        costs={costs({
          source: "estimate",
          reason: "no_permission",
          adminNotice: { error: null, reconnect: false },
        })}
        accountType="ORGANIZATION"
      />,
    );
    expect(html).toContain("Administration: read");
    expect(html).not.toContain("/admin/github");
  });
});
