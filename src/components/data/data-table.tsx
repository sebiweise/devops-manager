import { ArrowDown, ArrowUp } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { hrefWith, type SearchParamsLike, type SortDir } from "@/lib/url-state";
import { ExpandableRow } from "./expandable-row";

/**
 * The paged table of the insights pages (UI overhaul §1.7). Server
 * component: the page passes one page of rows from the data layer, which
 * did the search, filter, sort and LIMIT/OFFSET.
 *
 * - Typed columns with an optional sort key: sortable headers are links
 *   (`?sort=runs&dir=desc`, page reset) with `aria-sort`.
 * - `hideBelow` hides a column under `sm`/`md`/`lg`; those columns, plus
 *   `expanderOnly` ones and `extra`, show in a per-row disclosure instead,
 *   so no value is lost on a narrow screen. The toggle sits in a narrow
 *   leading cell and opens a full-width detail row (`ExpandableRow`), so a
 *   table fits a phone without sideways scrolling.
 * - `muted` rows (ignored repositories) render dimmed.
 * - `magnitude` draws a 4px bar behind the value of the sorted column, so
 *   a sorted table still reads as a leaderboard.
 * - `select` slots take the client checkboxes of a selection island.
 */

export type Breakpoint = "sm" | "md" | "lg";

export type Column<T> = {
  id: string;
  header: ReactNode;
  /** Plain text of the header, for the expander and the sort link name. */
  label: string;
  cell: (row: T) => ReactNode;
  sortKey?: string;
  align?: "left" | "right";
  hideBelow?: Breakpoint;
  /** Only in the row expander. */
  expanderOnly?: boolean;
  /** 0..1, drawn as a bar behind the cell while this column is sorted. */
  magnitude?: (row: T) => number | null;
  className?: string;
};

export type TableSort = {
  key: string;
  dir: SortDir;
  base: string;
  params: SearchParamsLike;
};

const BREAKPOINTS: readonly Breakpoint[] = ["sm", "md", "lg"];

const HIDE: Record<Breakpoint, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};
const SHOW_IN_EXPANDER: Record<Breakpoint, string> = {
  sm: "sm:hidden",
  md: "md:hidden",
  lg: "lg:hidden",
};

function SortHeader<T>({
  column,
  sort,
}: {
  column: Column<T>;
  sort: TableSort;
}) {
  const t = useTranslations("table");
  const active = sort.key === column.sortKey;
  const numeric = column.align === "right";
  const next: SortDir = active
    ? sort.dir === "asc"
      ? "desc"
      : "asc"
    : numeric
      ? "desc"
      : "asc";
  return (
    <Link
      href={hrefWith(sort.base, sort.params, {
        sort: column.sortKey,
        dir: next,
        page: undefined,
      })}
      aria-label={t("sortBy", {
        column: column.label,
        dir: next === "asc" ? t("ascending") : t("descending"),
      })}
      className={cn(
        "inline-flex items-center gap-1 underline-offset-2 hover:underline",
        numeric && "flex-row-reverse",
      )}
    >
      {column.header}
      {active ? (
        sort.dir === "asc" ? (
          <ArrowUp aria-hidden="true" className="size-3" />
        ) : (
          <ArrowDown aria-hidden="true" className="size-3" />
        )
      ) : null}
    </Link>
  );
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  rowName,
  sort,
  muted,
  extra,
  empty,
  selectHeader,
  selectCell,
  expanderLabel,
  tail,
  className,
}: {
  caption: string;
  columns: ReadonlyArray<Column<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T) => string;
  /** Short name of a row, for the accessible name of its disclosure toggle. */
  rowName?: (row: T) => string;
  sort?: TableSort;
  muted?: (row: T) => boolean;
  /** Secondary fields for the expander (labels, OS, workflow list). */
  extra?: (row: T) => ReactNode;
  empty?: ReactNode;
  selectHeader?: ReactNode;
  selectCell?: (row: T) => ReactNode;
  /** Accessible name of a row's disclosure toggle (default "More"). */
  expanderLabel?: (row: T) => string;
  /**
   * Rows rendered last, outside the sort and paging (e.g. "Ignored
   * repositories" on the costs page), muted and in italics.
   */
  tail?: ReadonlyArray<T>;
  className?: string;
}) {
  const t = useTranslations("table");
  const visible = columns.filter((c) => !c.expanderOnly);
  const collapsible = columns.filter((c) => c.expanderOnly || c.hideBelow);
  const hasExpander = collapsible.length > 0 || !!extra;
  // The toggle and the detail row disappear once every hidden column fits.
  const widest =
    collapsible.some((c) => c.expanderOnly) || extra
      ? null
      : ([...BREAKPOINTS]
          .reverse()
          .find((b) => collapsible.some((c) => c.hideBelow === b)) ?? null);
  const toggleClass = widest ? SHOW_IN_EXPANDER[widest] : undefined;
  const colSpan = (selectCell ? 1 : 0) + 1 + visible.length;

  if (rows.length === 0 && (tail?.length ?? 0) === 0 && empty)
    return <>{empty}</>;

  const dataCells = (row: T) =>
    visible.map((c) => {
      const m = sort && c.sortKey === sort.key ? c.magnitude?.(row) : null;
      return (
        <TableCell
          key={c.id}
          className={cn(
            c.align === "right" && "text-right tabular-nums",
            c.hideBelow && HIDE[c.hideBelow],
            m != null && "relative",
            c.className,
          )}
        >
          {m != null ? (
            <span
              aria-hidden="true"
              className={cn(
                "absolute bottom-1 h-1 rounded-r-full bg-series-1/70",
                c.align === "right" ? "right-2" : "left-2",
              )}
              style={{
                width: `calc(${Math.round(Math.min(1, Math.max(0, m)) * 100)}% - 1rem)`,
              }}
            />
          ) : null}
          {c.cell(row)}
        </TableCell>
      );
    });

  const detailOf = (row: T) => (
    <div className="flex flex-col gap-2 text-sm">
      {collapsible.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5 sm:grid-cols-[auto_1fr_auto_1fr]">
          {collapsible.map((c) => {
            const only =
              c.hideBelow && !c.expanderOnly
                ? SHOW_IN_EXPANDER[c.hideBelow]
                : undefined;
            return (
              <div key={c.id} className="contents">
                <dt className={cn("text-xs text-muted-foreground", only)}>
                  {c.label}
                </dt>
                <dd className={cn("min-w-0", only)}>{c.cell(row)}</dd>
              </div>
            );
          })}
        </dl>
      ) : null}
      {extra ? <div>{extra(row)}</div> : null}
    </div>
  );

  return (
    <Table className={className}>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          {selectCell ? (
            <TableHead className="w-8">{selectHeader}</TableHead>
          ) : null}
          {hasExpander ? (
            <TableHead
              scope="col"
              className={cn("w-px pr-0 pl-0 sm:pl-1", toggleClass)}
            >
              <span className="sr-only">{t("details")}</span>
            </TableHead>
          ) : null}
          {visible.map((c) => (
            <TableHead
              key={c.id}
              scope="col"
              aria-sort={
                sort && c.sortKey && sort.key === c.sortKey
                  ? sort.dir === "asc"
                    ? "ascending"
                    : "descending"
                  : undefined
              }
              className={cn(
                // Long headers wrap on a phone instead of widening the table.
                "whitespace-normal sm:whitespace-nowrap",
                c.align === "right" && "text-right",
                c.hideBelow && HIDE[c.hideBelow],
              )}
            >
              {sort && c.sortKey ? (
                <SortHeader column={c} sort={sort} />
              ) : (
                c.header
              )}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const isMuted = muted?.(row) ?? false;
          const rowClass = cn(isMuted && "text-muted-foreground");
          if (!hasExpander)
            return (
              <TableRow
                key={rowKey(row)}
                data-muted={isMuted || undefined}
                className={rowClass}
              >
                {selectCell ? <TableCell>{selectCell(row)}</TableCell> : null}
                {dataCells(row)}
              </TableRow>
            );
          const name = rowName?.(row);
          return (
            <ExpandableRow
              key={rowKey(row)}
              lead={selectCell ? (selectCell(row) ?? null) : undefined}
              cells={dataCells(row)}
              detail={detailOf(row)}
              colSpan={colSpan}
              label={
                expanderLabel?.(row) ??
                (name ? t("moreAbout", { name }) : t("more"))
              }
              muted={isMuted}
              className={rowClass}
              toggleClassName={toggleClass}
            />
          );
        })}
        {(tail ?? []).map((row) => (
          <TableRow
            key={`tail-${rowKey(row)}`}
            data-tail
            className="text-muted-foreground italic"
          >
            {selectCell ? <TableCell /> : null}
            {hasExpander ? (
              <TableCell className={cn("pr-0 pl-0 sm:pl-1", toggleClass)} />
            ) : null}
            {visible.map((c) => (
              <TableCell
                key={c.id}
                className={cn(
                  c.align === "right" && "text-right tabular-nums",
                  c.hideBelow && HIDE[c.hideBelow],
                  c.className,
                )}
              >
                {c.cell(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
