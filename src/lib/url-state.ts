import { z } from "zod";
import { compareCodeUnits } from "@/lib/compare";

/**
 * URL state of the paged tables (UI overhaul §1.6, §1.7, §4.5): search
 * `q`, filter chips `f` (comma-separated), sort key and direction, page and
 * page size. Every value is parsed with zod against an allow-list, so a
 * hand-edited URL never errors and an unknown sort key falls back to the
 * table's default. Pure and client-safe (the filter bar uses the same
 * helpers as the server).
 */

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;
export const MAX_QUERY_LENGTH = 200;

export type SortDir = "asc" | "desc";

export type SearchParamsLike =
  Record<string, string | string[] | undefined> | URLSearchParams;

/** The first value of a search param, or undefined when missing or empty. */
export function first(sp: SearchParamsLike, key: string): string | undefined {
  const v =
    sp instanceof URLSearchParams ? (sp.get(key) ?? undefined) : sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === "" ? undefined : s;
}

export type TableSpec<S extends string, F extends string> = {
  sorts: readonly S[];
  defaultSort: S;
  /** Direction per sort key when the URL has none (default "desc" for numbers). */
  defaultDir?: Partial<Record<S, SortDir>> | SortDir;
  filters?: readonly F[];
};

export type TableQuery<S extends string, F extends string> = {
  q: string | undefined;
  sort: S;
  dir: SortDir;
  page: number;
  size: PageSize;
  filters: F[];
};

const pageSchema = z.coerce.number().int().min(1).max(100_000).catch(1);
const sizeSchema = z.coerce
  .number()
  .int()
  .refine((n) => (PAGE_SIZES as readonly number[]).includes(n))
  .catch(DEFAULT_PAGE_SIZE);
const dirSchema = z.enum(["asc", "desc"]);

function defaultDirOf<S extends string, F extends string>(
  spec: TableSpec<S, F>,
  sort: S,
): SortDir {
  if (typeof spec.defaultDir === "string") return spec.defaultDir;
  return spec.defaultDir?.[sort] ?? "desc";
}

/** Parses a table's URL state; anything invalid falls back to the default. */
export function parseTableQuery<S extends string, F extends string = never>(
  sp: SearchParamsLike,
  spec: TableSpec<S, F>,
): TableQuery<S, F> {
  const rawSort = first(sp, "sort");
  const sort = (spec.sorts as readonly string[]).includes(rawSort ?? "")
    ? (rawSort as S)
    : spec.defaultSort;
  const dirParsed = dirSchema.safeParse(first(sp, "dir"));
  const q = first(sp, "q")?.trim().slice(0, MAX_QUERY_LENGTH) || undefined;
  const allowed = new Set<string>(spec.filters ?? []);
  const filters = [
    ...new Set(
      (first(sp, "f") ?? "")
        .split(",")
        .map((f) => f.trim())
        .filter((f) => allowed.has(f)),
    ),
  ] as F[];
  return {
    q,
    sort,
    dir: dirParsed.success ? dirParsed.data : defaultDirOf(spec, sort),
    page: pageSchema.parse(first(sp, "page") ?? 1),
    size: sizeSchema.parse(first(sp, "size") ?? DEFAULT_PAGE_SIZE) as PageSize,
    filters,
  };
}

/**
 * The search params of a table query, leaving out defaults so URLs stay
 * short (`?sort=runs&dir=desc&f=forks,private&page=2`).
 */
export function serializeTableQuery<S extends string, F extends string>(
  query: Partial<TableQuery<S, F>>,
  spec: TableSpec<S, F>,
): Record<string, string | undefined> {
  const sort = query.sort ?? spec.defaultSort;
  const dir = query.dir ?? defaultDirOf(spec, sort);
  return {
    q: query.q || undefined,
    f:
      query.filters && query.filters.length > 0
        ? [...query.filters].sort(compareCodeUnits).join(",")
        : undefined,
    sort:
      sort === spec.defaultSort && dir === defaultDirOf(spec, sort)
        ? undefined
        : sort,
    dir: dir === defaultDirOf(spec, sort) ? undefined : dir,
    page: query.page && query.page > 1 ? String(query.page) : undefined,
    size:
      query.size && query.size !== DEFAULT_PAGE_SIZE
        ? String(query.size)
        : undefined,
  };
}

/**
 * `href` with `patch` applied to its query string: `undefined` or "" removes
 * a key, every other key (e.g. `range`) is kept.
 */
export function withParams(
  href: string,
  patch: Record<string, string | number | undefined | null>,
): string {
  const [pathAndQuery, hash = ""] = href.split("#", 2) as [string, string?];
  const [path, query = ""] = pathAndQuery.split("?", 2) as [string, string?];
  const params = new URLSearchParams(query);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === "") params.delete(k);
    else params.set(k, String(v));
  }
  const s = params.toString();
  return `${path}${s ? `?${s}` : ""}${hash ? `#${hash}` : ""}`;
}

/** A href for `base` with the current params, `patch` applied. */
export function hrefWith(
  base: string,
  current: SearchParamsLike,
  patch: Record<string, string | number | undefined | null>,
): string {
  const params = new URLSearchParams();
  const entries =
    current instanceof URLSearchParams
      ? [...current.entries()]
      : Object.entries(current).flatMap(([k, v]) =>
          v === undefined ? [] : [[k, Array.isArray(v) ? (v[0] ?? "") : v]],
        );
  for (const [k, v] of entries)
    if (v !== "") params.set(k as string, v as string);
  const s = params.toString();
  return withParams(s ? `${base}?${s}` : base, patch);
}

/** Toggles one filter chip in a filter list (sorted for stable URLs). */
export function toggleFilter<F extends string>(
  filters: readonly F[],
  filter: F,
): F[] {
  return filters.includes(filter)
    ? filters.filter((f) => f !== filter)
    : [...filters, filter].sort(compareCodeUnits);
}

export type PageWindow = {
  /** 1-based index of the first row shown, 0 when there are none. */
  from: number;
  to: number;
  total: number;
  page: number;
  pages: number;
  /** Page numbers to link: first, last and the current page ±2; null = gap. */
  links: Array<number | null>;
};

/** What the pagination footer shows for a page of a result. */
export function pageWindow(
  page: number,
  size: number,
  total: number,
): PageWindow {
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (current - 1) * size + 1;
  const to = Math.min(total, current * size);
  const wanted = new Set<number>([1, pages]);
  for (let p = current - 2; p <= current + 2; p++)
    if (p >= 1 && p <= pages) wanted.add(p);
  const sorted = [...wanted].sort((a, b) => a - b);
  const links: Array<number | null> = [];
  for (const [i, p] of sorted.entries()) {
    if (i > 0 && p - sorted[i - 1]! > 1) links.push(null);
    links.push(p);
  }
  return { from, to, total, page: current, pages, links };
}

/** Offset and limit of a page, clamped to the result size. */
export function pageBounds(
  page: number,
  size: number,
): { offset: number; limit: number } {
  return { offset: (Math.max(1, page) - 1) * size, limit: size };
}
