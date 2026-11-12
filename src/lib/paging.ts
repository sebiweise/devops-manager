import type { SortDir } from "./url-state";

/**
 * Server-side paging, search and sort for lists the data layer already
 * computes in full (workflow stats, runners, queue jobs, cost rows): one
 * allow-listed sort key per column, nulls always last, a stable tie-break,
 * and a page clamped to the last one. Lists read straight from SQL page with
 * LIMIT/OFFSET instead (listRepoStats).
 */

export type Page<T> = {
  rows: T[];
  total: number;
  /** The page actually returned (clamped to 1..pages). */
  page: number;
  size: number;
};

export type SortValue = number | string | null | undefined;

export type PageQuery<S extends string> = {
  q?: string;
  sort: S;
  dir: SortDir;
  page: number;
  size: number;
};

export type PageSpec<T, S extends string> = {
  /** Text the search matches (case-insensitive substring). */
  text: (row: T) => string;
  keys: Record<S, (row: T) => SortValue>;
  /** Tie-break for equal keys (default: the search text). */
  tiebreak?: (a: T, b: T) => number;
  /** Extra filter (chips) applied before search, sort and paging. */
  filter?: (row: T) => boolean;
};

export function compareValues(
  a: SortValue,
  b: SortValue,
  dir: SortDir,
): number {
  const na =
    a === null || a === undefined || (typeof a === "number" && Number.isNaN(a));
  const nb =
    b === null || b === undefined || (typeof b === "number" && Number.isNaN(b));
  if (na && nb) return 0;
  if (na) return 1;
  if (nb) return -1;
  const d = dir === "asc" ? 1 : -1;
  if (typeof a === "string" && typeof b === "string")
    return a.localeCompare(b) * d;
  if (a === b) return 0;
  return (a! < b! ? -1 : 1) * d;
}

/** Filters, searches, sorts and slices `rows`. */
export function pageRows<T, S extends string>(
  rows: ReadonlyArray<T>,
  query: PageQuery<S>,
  spec: PageSpec<T, S>,
): Page<T> {
  const q = query.q?.trim().toLowerCase();
  const key = spec.keys[query.sort];
  const tiebreak =
    spec.tiebreak ?? ((a: T, b: T) => spec.text(a).localeCompare(spec.text(b)));
  const matched = rows.filter(
    (r) =>
      (!spec.filter || spec.filter(r)) &&
      (!q || spec.text(r).toLowerCase().includes(q)),
  );
  const sorted = matched
    .slice()
    .sort((a, b) => compareValues(key(a), key(b), query.dir) || tiebreak(a, b));
  const size = Math.max(1, query.size);
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const page = Math.min(Math.max(1, query.page), pages);
  return {
    rows: sorted.slice((page - 1) * size, page * size),
    total: sorted.length,
    page,
    size,
  };
}
