// @vitest-environment jsdom
import axe from "axe-core";
import { TriangleAlert } from "lucide-react";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/o/example-org/repos",
  useSearchParams: () => new URLSearchParams("range=30d&f=forks&q=repo"),
}));
vi.mock("@/server/actions/sync", () => ({ syncNow: vi.fn() }));
vi.mock("@/server/actions/repos", () => ({
  ignoreRepositoriesAction: vi.fn(),
  unignoreRepositoriesAction: vi.fn(),
}));

const { DataTable } = await import("./data-table");
const { Pagination, CursorFooter } = await import("./pagination");
const {
  FilterBar,
  SearchBox,
  FilterChips,
  SortSelect,
  QuickViews,
  ClearFilters,
} = await import("./filter-bar");
const { KpiStrip, KpiTile } = await import("./kpi-strip");
const { StatusBadge, RunStatusBadge } = await import("./status-badge");
const { EmptyState } = await import("./empty-state");
const {
  SelectionProvider,
  SelectPageCheckbox,
  SelectRowCheckbox,
  SelectionBar,
} = await import("./selection");
const { PageHeader } = await import("../shell/page-header");
const { GettingStarted } = await import("../shell/getting-started");
const { Breadcrumbs } = await import("../shell/breadcrumbs");
const { FreshnessChip } = await import("../shell/freshness-chip");
const { RepoIgnoreButton, RepoRowMenu, IgnoreSelectedButton } =
  await import("../management/repo-ignore");

/**
 * The shared building blocks of the UI overhaul (§1): what they render and
 * axe-core over each (no critical or serious violations), in English and
 * German.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "en" ? en : de}
      timeZone="UTC"
      now={new Date("2026-11-12T12:00:00Z")}
    >
      <main>
        <h1>Blocks</h1>
        {node}
      </main>
    </NextIntlClientProvider>,
  );
}

async function violations(html: string) {
  document.documentElement.lang = "en";
  document.title = "Blocks";
  document.body.innerHTML = html;
  const result = await axe.run(document.body, {
    resultTypes: ["violations"],
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations
    .filter((v) => v.impact === "critical" || v.impact === "serious")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

type Row = { id: string; name: string; runs: number; ignored: boolean };
const rows: Row[] = [
  { id: "1", name: "example-org/repo-a", runs: 12, ignored: false },
  { id: "2", name: "example-org/repo-b", runs: 3, ignored: true },
];

function Table() {
  return (
    <DataTable<Row>
      caption="Repositories"
      rows={rows}
      rowKey={(r) => r.id}
      rowName={(r) => r.name}
      muted={(r) => r.ignored}
      sort={{
        key: "runs",
        dir: "desc",
        base: "/o/example-org/repos",
        params: { range: "30d", page: "2" },
      }}
      columns={[
        {
          id: "name",
          label: "Repository",
          header: "Repository",
          sortKey: "name",
          cell: (r) => r.name,
        },
        {
          id: "runs",
          label: "Runs",
          header: "Runs",
          sortKey: "runs",
          align: "right",
          magnitude: (r) => r.runs / 12,
          cell: (r) => (r.ignored ? "—" : String(r.runs)),
        },
        {
          id: "p50",
          label: "Typical",
          header: "Typical",
          hideBelow: "lg",
          cell: () => "1m 10s",
        },
        {
          id: "labels",
          label: "Labels",
          header: "Labels",
          expanderOnly: true,
          cell: () => "self-hosted",
        },
      ]}
    />
  );
}

describe("DataTable", () => {
  it("renders sortable headers, aria-sort, muted rows and the expander", () => {
    const html = render(<Table />);
    expect(html).toContain('aria-sort="descending"');
    // The active column flips direction and resets the page, keeping range.
    expect(html).toContain(
      'href="/o/example-org/repos?range=30d&amp;sort=runs&amp;dir=asc"',
    );
    expect(html).toContain(
      'href="/o/example-org/repos?range=30d&amp;sort=name&amp;dir=asc"',
    );
    expect(html).toContain('data-muted="true"');
    // The disclosure toggle leads the row; its detail row spans the table.
    const doc = new DOMParser().parseFromString(
      `<table>${html.slice(html.indexOf("<thead"), html.lastIndexOf("</table>"))}</table>`,
      "text/html",
    );
    const first = doc.querySelector("tbody tr")!;
    const toggle = first.querySelector("td:first-child button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe(
      "More about example-org/repo-a",
    );
    const detail = doc.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(detail.hasAttribute("hidden")).toBe(true);
    expect(detail.querySelector("td")!.getAttribute("colspan")).toBe(
      String(doc.querySelectorAll("thead th").length),
    );
    expect(detail.textContent).toContain("self-hosted");
    expect(detail.textContent).toContain("Typical");
    // The magnitude bar is drawn for the sorted column only.
    expect(html.match(/bg-series-1\/70/g)).toHaveLength(2);
  });

  it("shows the empty state instead of an empty table", () => {
    const html = render(
      <DataTable<Row>
        caption="Repositories"
        rows={[]}
        rowKey={(r) => r.id}
        columns={[{ id: "n", label: "N", header: "N", cell: (r) => r.name }]}
        empty={<EmptyState message="No repository matches." />}
      />,
    );
    expect(html).toContain("No repository matches.");
    expect(html).not.toContain("<table");
  });

  it("passes axe", async () => {
    expect(await violations(render(<Table />))).toEqual([]);
  });
});

describe("Pagination", () => {
  it("shows the range and page links that keep the other params", () => {
    const html = render(
      <Pagination
        base="/o/example-org/repos"
        params={{ range: "30d", page: "2", f: "forks" }}
        page={2}
        size={25}
        total={142}
      />,
    );
    expect(html).toContain("26-50 of 142");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="/o/example-org/repos?range=30d&amp;f=forks"');
    expect(html).toContain(
      'href="/o/example-org/repos?range=30d&amp;page=3&amp;f=forks"',
    );
    expect(html).toContain("Rows per page");
  });

  it("is German in German", () => {
    const html = render(
      <Pagination base="/x" params={{}} page={1} size={25} total={1234} />,
      "de",
    );
    expect(html).toContain("1-25 von 1.234");
    expect(html).toContain("Zeilen pro Seite");
  });

  it("passes axe, with the cursor footer too", async () => {
    expect(
      await violations(
        render(
          <>
            <Pagination base="/x" params={{}} page={3} size={25} total={300} />
            <CursorFooter shown={50} olderHref="/x?before=1" />
          </>,
        ),
      ),
    ).toEqual([]);
  });
});

describe("FilterBar", () => {
  const bar = (
    <FilterBar>
      <SearchBox label="Filter repositories" />
      <FilterChips
        label="Filter repositories"
        options={[
          { value: "forks", label: "Forks", count: 4 },
          { value: "ignored", label: "Show ignored", count: 1 },
        ]}
      />
      <SortSelect
        label="Sort"
        value="runs:desc"
        options={[
          { value: "runs", dir: "desc", label: "Most runs" },
          { value: "name", dir: "asc", label: "Name" },
        ]}
      />
      <QuickViews
        label="Quick views"
        views={[
          {
            id: "slowest",
            label: "Slowest p95",
            sort: "p95",
            dir: "desc",
            filters: [],
          },
        ]}
      />
      <ClearFilters />
    </FilterBar>
  );

  it("chips toggle their filter in the URL and reset the page", () => {
    const html = render(bar);
    expect(html).toContain('aria-pressed="true"');
    // Forks is on: its link removes it; Show ignored adds it.
    expect(html).toContain('href="/o/example-org/repos?range=30d&amp;q=repo"');
    expect(html).toContain(
      'href="/o/example-org/repos?range=30d&amp;f=forks%2Cignored&amp;q=repo"',
    );
    expect(html).toContain("Clear filters");
    expect(html).toContain('value="repo"');
  });

  it("passes axe", async () => {
    expect(await violations(render(bar))).toEqual([]);
  });
});

describe("KpiStrip, StatusBadge, PageHeader, EmptyState", () => {
  const strip = (
    <KpiStrip label="Key figures">
      <KpiTile
        variant="hero"
        label="Net this month"
        value="$12.50"
        hint="Gross $40 − discount $27.50"
      />
      <KpiTile
        label="Runs"
        value="1,284"
        info="Completed runs in the range."
        href="/o/example-org/repos"
      />
      <KpiTile
        variant="meter"
        label="Minutes"
        value="3,100 / 3,000"
        ratio={1.03}
        overLabel="Above included"
      />
      <KpiTile
        variant="delta"
        label="Success"
        value="92 %"
        delta={-0.03}
        deltaText="−3 pts vs previous 7 days"
      />
      <KpiTile
        variant="status"
        label="Stuck"
        value="2"
        icon={TriangleAlert}
        tone="critical"
      />
    </KpiStrip>
  );

  it("renders every variant with text, not colour alone", () => {
    const html = render(strip);
    expect(html).toContain("text-4xl");
    expect(html).toContain("Above included");
    expect(html).toContain("−3 pts vs previous 7 days");
    expect(html).toContain('href="/o/example-org/repos"');
    expect(html).toContain("Completed runs in the range.");
  });

  it("badges carry an icon, a text and their definition", () => {
    const html = render(
      <>
        <StatusBadge kind="stuck" />
        <StatusBadge kind="ignored" />
        <RunStatusBadge status="COMPLETED" conclusion="FAILURE" />
        <RunStatusBadge status="SOMETHING_NEW" conclusion={null} />
      </>,
      "de",
    );
    expect(html).toContain("Hängt fest");
    expect(html).toContain("seit mehr als 15 Minuten");
    expect(html).toContain("Ignoriert");
    expect(html).toContain("Fehlgeschlagen");
    expect(html).toContain("something new");
    expect(html.match(/<svg/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("passes axe", async () => {
    expect(
      await violations(
        render(
          <>
            <PageHeader
              title="Repositories"
              subtitle="42 repositories · 5 ignored"
              actions={<button type="button">Refresh</button>}
              info="Sampling every 10 minutes."
              infoLabel="About these numbers"
            />
            {strip}
            <StatusBadge kind="noRunner" />
            <StatusBadge kind="fork" />
            <EmptyState message="No job waits for approval" quiet />
            <EmptyState message="No runs yet." />
          </>,
        ),
      ),
    ).toEqual([]);
  });
});

describe("shell blocks", () => {
  it("breadcrumbs keep the range and mark the current page", () => {
    const html = render(
      <Breadcrumbs
        range="30d"
        items={[
          { kind: "accounts" },
          { kind: "account", login: "example-org" },
          { kind: "section", login: "example-org", section: "repos" },
          {
            kind: "repo",
            login: "example-org",
            name: "repo-a",
            fullName: "example-org/repo-a",
          },
          {
            kind: "workflow",
            login: "example-org",
            repoFullName: "example-org/repo-a",
            name: "CI",
            id: "301",
          },
          {
            kind: "run",
            login: "example-org",
            id: "9001",
            number: 123,
            attempt: 2,
          },
        ]}
      />,
    );
    expect(html).toContain('href="/dashboard?range=30d"');
    expect(html).toContain(
      'href="/o/example-org/repos/repo-a/workflows/301?range=30d"',
    );
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Run #123 (attempt 2)");
  });

  it("getting started shows the three steps with the import meter", () => {
    const html = render(
      <GettingStarted
        importProgress={0.4}
        webhookReceived={false}
        settingsHref="/o/example-org/settings"
      />,
      "de",
    );
    expect(html).toContain("GitHub-App installiert");
    expect(html).toContain('aria-valuenow="40"');
    expect(html).toContain("Erster Webhook empfangen");
    expect(html).toContain("Einstellungen &amp; Abgleich");
  });

  it("the freshness chip names the data age", () => {
    const html = render(
      <FreshnessChip
        lastWebhookAt="2026-11-12T11:57:00Z"
        lastReconciledAt="2026-11-12T09:00:00Z"
        stale={false}
        installationId="2002"
        canSync
        now="2026-11-12T12:00:00Z"
      />,
      "de",
    );
    expect(html).toContain("Daten aktualisiert vor 3 Minuten");
  });

  it("pass axe", async () => {
    expect(
      await violations(
        render(
          <>
            <Breadcrumbs
              items={[
                { kind: "accounts" },
                { kind: "account", login: "example-org" },
              ]}
            />
            <GettingStarted importProgress={null} webhookReceived />
            <FreshnessChip
              lastWebhookAt={null}
              lastReconciledAt={null}
              stale
              installationId="2002"
              canSync={false}
              now="2026-11-12T12:00:00Z"
            />
          </>,
        ),
      ),
    ).toEqual([]);
  });
});

describe("selection and ignore controls", () => {
  const items = [
    { id: "1", label: "example-org/repo-a", fork: true },
    { id: "2", label: "example-org/repo-b" },
  ];

  it("render named checkboxes and buttons, and pass axe", async () => {
    const html = render(
      <SelectionProvider page={items} matching={items} total={2}>
        <table>
          <caption>Repositories</caption>
          <thead>
            <tr>
              <th>
                <SelectPageCheckbox />
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>
                  <SelectRowCheckbox item={i} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <SelectionBar>
          <IgnoreSelectedButton installationId="2002" />
        </SelectionBar>
        <RepoIgnoreButton
          installationId="2002"
          mode="unignore"
          repos={[{ id: "1", fullName: "example-org/repo-a" }]}
        />
        <RepoRowMenu
          installationId="2002"
          repo={{ id: "1", fullName: "example-org/repo-a", fork: true }}
          ignored={false}
          canIgnore
        />
      </SelectionProvider>,
    );
    expect(html).toContain('aria-label="Select example-org/repo-a"');
    expect(html).toContain('aria-label="Actions for example-org/repo-a"');
    expect(await violations(html)).toEqual([]);
  });
});
