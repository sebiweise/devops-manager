import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
  hrefWith,
  PAGE_SIZES,
  pageWindow,
  type SearchParamsLike,
} from "@/lib/url-state";
import { PageSizeSelect } from "./page-size-select";

/**
 * The footer of a paged table (UI overhaul §1.7): "1-25 of 142", previous
 * and next, links to the first, the last and the pages around the current
 * one, and the rows-per-page select. Links keep every other URL param
 * (range, filters, sort).
 */
export function Pagination({
  base,
  params,
  page,
  size,
  total,
}: {
  base: string;
  params: SearchParamsLike;
  page: number;
  size: number;
  total: number;
}) {
  const t = useTranslations("table");
  const format = useFormatter();
  const w = pageWindow(page, size, total);
  const href = (p: number) =>
    hrefWith(base, params, { page: p > 1 ? p : undefined });
  const n = (v: number) => format.number(v);
  const linkClass =
    "inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm hover:bg-accent";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
      <p className="text-muted-foreground" aria-live="polite">
        {total === 0
          ? t("noRows")
          : t("range", { from: n(w.from), to: n(w.to), total: n(w.total) })}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {w.pages > 1 ? (
          <nav aria-label={t("pagination")} className="flex items-center gap-1">
            {w.page > 1 ? (
              <Link href={href(w.page - 1)} className={linkClass} rel="prev">
                <ChevronLeft aria-hidden="true" className="size-4" />
                <span>{t("previous")}</span>
              </Link>
            ) : null}
            {w.links.map((p, i) =>
              p === null ? (
                <span
                  key={`gap-${i}`}
                  aria-hidden="true"
                  className="px-1 text-muted-foreground"
                >
                  …
                </span>
              ) : (
                <Link
                  key={p}
                  href={href(p)}
                  aria-current={p === w.page ? "page" : undefined}
                  aria-label={t("pageN", { page: n(p) })}
                  className={cn(
                    linkClass,
                    p === w.page && "bg-secondary font-medium",
                  )}
                >
                  {n(p)}
                </Link>
              ),
            )}
            {w.page < w.pages ? (
              <Link href={href(w.page + 1)} className={linkClass} rel="next">
                <span>{t("next")}</span>
                <ChevronRight aria-hidden="true" className="size-4" />
              </Link>
            ) : null}
          </nav>
        ) : null}
        {total > PAGE_SIZES[0] ? (
          <PageSizeSelect
            value={size}
            hrefs={Object.fromEntries(
              PAGE_SIZES.map((s) => [
                s,
                hrefWith(base, params, {
                  size: s === PAGE_SIZES[0] ? undefined : s,
                  page: undefined,
                }),
              ]),
            )}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Cursor paging footer (runs): "Showing 50 newest" and "Older runs". */
export function CursorFooter({
  shown,
  olderHref,
  newestHref,
}: {
  shown: number;
  olderHref: string | null;
  /** Back to the newest page, when not on it. */
  newestHref?: string | null;
}) {
  const t = useTranslations("table");
  const format = useFormatter();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
      <p className="text-muted-foreground">
        {newestHref
          ? t("cursorShown", { count: format.number(shown) })
          : t("cursorNewest", { count: format.number(shown) })}
      </p>
      <nav aria-label={t("pagination")} className="flex items-center gap-3">
        {newestHref ? (
          <Link
            href={newestHref}
            className="underline-offset-2 hover:underline"
          >
            {t("newest")}
          </Link>
        ) : null}
        {olderHref ? (
          <Link
            href={olderHref}
            rel="next"
            className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
          >
            {t("older")}
            <ChevronRight aria-hidden="true" className="size-4" />
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
