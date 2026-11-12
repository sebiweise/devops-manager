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

/**
 * The paged table of the insights pages (UI overhaul §1.7). Server
 * component: the page passes one page of rows from the data layer, which
 * did the search, filter, sort and LIMIT/OFFSET.
 *
 * - Typed columns with an optional sort key: sortable headers are links
 *   (`?sort=runs&dir=desc`, page reset) with `aria-sort`.
 * - `hideBelow` hides a column under `md`/`lg`; those columns, plus
 *   `expanderOnly` ones and `extra`, show in a per-row disclosure instead,
 *   so no value is lost on a narrow screen.
 * - `muted` rows (ignored repositories) render dimmed.
 * - `magnitude` draws a 4px bar behind the value of the sorted column, so
 *   a sorted table still reads as a leaderboard.
 * - `select` slots take the client checkboxes of a selection island.
 */

export type Column<T> = {
  id: string;
  header: ReactNode;
  /** Plain text of the header, for the expander and the sort link name. */
  label: string;
  cell: (row: T) => ReactNode;
  sortKey?: string;
  align?: "left" | "right";
  hideBelow?: "md" | "lg";
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

const HIDE: Record<"md" | "lg", string> = {
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};
const SHOW_IN_EXPANDER: Record<"md" | "lg", string> = {
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
  sort?: TableSort;
  muted?: (row: T) => boolean;
  /** Secondary fields for the expander (labels, OS, workflow list). */
  extra?: (row: T) => ReactNode;
  empty?: ReactNode;
  selectHeader?: ReactNode;
  selectCell?: (row: T) => ReactNode;
  /** Summary text of a row's disclosure (default "More"). */
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
  // The expander column itself disappears once every hidden column fits.
  const widest =
    collapsible.some((c) => c.expanderOnly) || extra
      ? null
      : collapsible.some((c) => c.hideBelow === "lg")
        ? "lg"
        : "md";

  if (rows.length === 0 && (tail?.length ?? 0) === 0 && empty)
    return <>{empty}</>;

  return (
    <Table className={className}>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          {selectCell ? (
            <TableHead className="w-8">{selectHeader}</TableHead>
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
          {hasExpander ? (
            <TableHead
              scope="col"
              className={cn("w-px", widest && SHOW_IN_EXPANDER[widest])}
            >
              <span className="sr-only">{t("details")}</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const isMuted = muted?.(row) ?? false;
          return (
            <TableRow
              key={rowKey(row)}
              data-muted={isMuted || undefined}
              className={cn(isMuted && "text-muted-foreground")}
            >
              {selectCell ? <TableCell>{selectCell(row)}</TableCell> : null}
              {visible.map((c) => {
                const m =
                  sort && c.sortKey === sort.key ? c.magnitude?.(row) : null;
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
              })}
              {hasExpander ? (
                <TableCell
                  className={cn(
                    "align-top",
                    widest && SHOW_IN_EXPANDER[widest],
                  )}
                >
                  <details className="group text-xs">
                    <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">
                      {expanderLabel?.(row) ?? t("more")}
                    </summary>
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 whitespace-normal">
                      {collapsible.map((c) => (
                        <div key={c.id} className="contents">
                          <dt
                            className={cn(
                              "text-muted-foreground",
                              c.hideBelow &&
                                !c.expanderOnly &&
                                SHOW_IN_EXPANDER[c.hideBelow],
                            )}
                          >
                            {c.label}
                          </dt>
                          <dd
                            className={cn(
                              c.hideBelow &&
                                !c.expanderOnly &&
                                SHOW_IN_EXPANDER[c.hideBelow],
                            )}
                          >
                            {c.cell(row)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    {extra ? <div className="mt-2">{extra(row)}</div> : null}
                  </details>
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
        {(tail ?? []).map((row) => (
          <TableRow
            key={`tail-${rowKey(row)}`}
            data-tail
            className="text-muted-foreground italic"
          >
            {selectCell ? <TableCell /> : null}
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
            {hasExpander ? (
              <TableCell className={cn(widest && SHOW_IN_EXPANDER[widest])} />
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
