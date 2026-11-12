import { describe, expect, it } from "vitest";
import { pageRows } from "./paging";
import { bucketDays, bucketOf, parseRange, resolveRange } from "./range";
import { REPO_TABLE, WORKFLOW_TABLE } from "./table-specs";
import {
  hrefWith,
  pageWindow,
  parseTableQuery,
  serializeTableQuery,
  toggleFilter,
  withParams,
} from "./url-state";

describe("parseTableQuery", () => {
  it("reads search, filters, sort, page and size", () => {
    const q = parseTableQuery(
      {
        q: "  repo-a ",
        f: "forks,ignored,bogus,forks",
        sort: "runs",
        dir: "asc",
        page: "3",
        size: "50",
      },
      REPO_TABLE,
    );
    expect(q).toEqual({
      q: "repo-a",
      filters: ["forks", "ignored"],
      sort: "runs",
      dir: "asc",
      page: 3,
      size: 50,
    });
  });

  it("falls back to the defaults for anything invalid", () => {
    const q = parseTableQuery(
      { sort: "drop table", dir: "sideways", page: "-4", size: "7" },
      REPO_TABLE,
    );
    expect(q).toMatchObject({
      sort: "lastRun",
      dir: "desc",
      page: 1,
      size: 25,
      filters: [],
      q: undefined,
    });
    // Name sorts ascending by default.
    expect(parseTableQuery({ sort: "name" }, REPO_TABLE).dir).toBe("asc");
    expect(
      parseTableQuery(new URLSearchParams("sort=success"), WORKFLOW_TABLE).dir,
    ).toBe("asc");
  });

  it("caps the search text", () => {
    expect(parseTableQuery({ q: "x".repeat(500) }, REPO_TABLE).q).toHaveLength(
      200,
    );
  });

  it("serialises without defaults and round-trips", () => {
    const query = parseTableQuery(
      { sort: "runs", dir: "asc", f: "private,forks", page: "2" },
      REPO_TABLE,
    );
    const out = serializeTableQuery(query, REPO_TABLE);
    expect(out).toEqual({
      q: undefined,
      f: "forks,private",
      sort: "runs",
      dir: "asc",
      page: "2",
      size: undefined,
    });
    const back = parseTableQuery(
      Object.fromEntries(
        Object.entries(out).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
      REPO_TABLE,
    );
    expect(back).toEqual({ ...query, filters: ["forks", "private"] });
    expect(serializeTableQuery({}, REPO_TABLE)).toEqual({
      q: undefined,
      f: undefined,
      sort: undefined,
      dir: undefined,
      page: undefined,
      size: undefined,
    });
  });
});

describe("hrefs", () => {
  it("withParams keeps other params and removes empty ones", () => {
    expect(
      withParams("/o/example-org/repos?range=30d&page=2", {
        page: undefined,
        sort: "runs",
      }),
    ).toBe("/o/example-org/repos?range=30d&sort=runs");
    expect(withParams("/dashboard", { range: undefined })).toBe("/dashboard");
    expect(withParams("/a?x=1#top", { y: 2 })).toBe("/a?x=1&y=2#top");
  });

  it("hrefWith applies a patch to the current params", () => {
    expect(
      hrefWith(
        "/o/example-org/repos",
        { range: "7d", q: "", f: ["forks"] },
        { page: 3 },
      ),
    ).toBe("/o/example-org/repos?range=7d&f=forks&page=3");
  });

  it("toggleFilter adds and removes a chip", () => {
    expect(toggleFilter(["private"], "forks")).toEqual(["forks", "private"]);
    expect(toggleFilter(["forks", "private"], "forks")).toEqual(["private"]);
  });
});

describe("pageWindow", () => {
  it("shows the range and the page links around the current page", () => {
    expect(pageWindow(1, 25, 142)).toEqual({
      from: 1,
      to: 25,
      total: 142,
      page: 1,
      pages: 6,
      links: [1, 2, 3, null, 6],
    });
    expect(pageWindow(6, 25, 142).from).toBe(126);
    expect(pageWindow(6, 25, 142).to).toBe(142);
    expect(pageWindow(10, 10, 300).links).toEqual([
      1,
      null,
      8,
      9,
      10,
      11,
      12,
      null,
      30,
    ]);
  });

  it("clamps the page and handles an empty result", () => {
    expect(pageWindow(99, 25, 30)).toMatchObject({ page: 2, from: 26, to: 30 });
    expect(pageWindow(1, 25, 0)).toMatchObject({
      from: 0,
      to: 0,
      pages: 1,
      links: [1],
    });
  });
});

describe("pageRows", () => {
  const rows = [
    { name: "repo-b", runs: 5, rate: 0.5 },
    { name: "repo-a", runs: 9, rate: null },
    { name: "repo-c", runs: 1, rate: 0.9 },
    { name: "fork-d", runs: 9, rate: 0.1 },
  ];
  const spec = {
    text: (r: (typeof rows)[number]) => r.name,
    keys: {
      name: (r: (typeof rows)[number]) => r.name,
      runs: (r: (typeof rows)[number]) => r.runs,
      rate: (r: (typeof rows)[number]) => r.rate,
    },
  };

  it("sorts with nulls last in both directions and a stable tie-break", () => {
    const by = (sort: "name" | "runs" | "rate", dir: "asc" | "desc") =>
      pageRows(rows, { sort, dir, page: 1, size: 25 }, spec).rows.map(
        (r) => r.name,
      );
    expect(by("runs", "desc")).toEqual([
      "fork-d",
      "repo-a",
      "repo-b",
      "repo-c",
    ]);
    expect(by("rate", "desc")).toEqual([
      "repo-c",
      "repo-b",
      "fork-d",
      "repo-a",
    ]);
    expect(by("rate", "asc")).toEqual(["fork-d", "repo-b", "repo-c", "repo-a"]);
  });

  it("searches, filters and pages", () => {
    const page = pageRows(
      rows,
      { q: " REPO ", sort: "name", dir: "asc", page: 2, size: 2 },
      { ...spec, filter: (r) => r.runs > 1 },
    );
    expect(page.total).toBe(2);
    expect(page.size).toBe(2);
    // Page 2 of a 2-row result clamps to page 1.
    expect(page.page).toBe(1);
    expect(page.rows.map((r) => r.name)).toEqual(["repo-a", "repo-b"]);
  });
});

describe("range", () => {
  it("prefers the param, then the cookie, then 7 days", () => {
    expect(resolveRange("30d", "90d")).toBe("30d");
    expect(resolveRange("bogus", "90d")).toBe("90d");
    expect(resolveRange(undefined, "bogus")).toBe("7d");
    expect(parseRange("12m")).toBe("12m");
    expect(parseRange(null, "30d")).toBe("30d");
  });

  it("buckets days by week (Monday) and month", () => {
    expect(bucketOf("2026-11-12", "week")).toBe("2026-11-09");
    expect(bucketOf("2026-11-09", "week")).toBe("2026-11-09");
    expect(bucketOf("2026-11-12", "month")).toBe("2026-11-01");
    expect(bucketOf("2026-11-12", "day")).toBe("2026-11-12");
    expect(
      bucketDays(
        [
          { day: "2026-11-09", runs: 2 },
          { day: "2026-11-12", runs: 3 },
          { day: "2026-11-16", runs: 1 },
        ],
        "week",
        ["runs"],
      ),
    ).toEqual([
      { bucket: "2026-11-09", runs: 5 },
      { bucket: "2026-11-16", runs: 1 },
    ]);
  });
});
