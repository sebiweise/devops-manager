"use client";

import { CalendarRange } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
  DEFAULT_RANGE,
  RANGES,
  rangeCookie,
  resolveRange,
  type InsightRange,
} from "@/lib/range";
import { hrefWith } from "@/lib/url-state";

/** Pages that follow the shared range (Queue is live, Costs is monthly). */
export function usesRange(pathname: string, accountBase: string): boolean {
  if (pathname === accountBase) return true;
  return ["/repos", "/workflows", "/runners"].some(
    (s) =>
      pathname === `${accountBase}${s}` ||
      pathname.startsWith(`${accountBase}${s}/`),
  );
}

/**
 * The one range control of the account header (UI overhaul §0 "Range"):
 * a segmented control that writes `?range=` and the `dm_range` cookie, so
 * the choice carries over to the next page. Links work without JavaScript
 * (then only the URL carries it). Hidden where the range does not apply.
 */
export function RangeControl({
  accountBase,
  cookieRange,
}: {
  accountBase: string;
  /** The range cookie read by the server (first paint matches). */
  cookieRange: InsightRange | null;
}) {
  const t = useTranslations("filters");
  const pathname = usePathname();
  const sp = useSearchParams();
  if (!usesRange(pathname, accountBase)) return null;
  const params = new URLSearchParams(sp.toString());
  const current = resolveRange(params.get("range"), cookieRange, DEFAULT_RANGE);
  return (
    <div
      role="group"
      aria-label={t("range")}
      className="inline-flex items-center gap-0.5 rounded-md border p-0.5"
    >
      <CalendarRange
        aria-hidden="true"
        className="mx-1 size-3.5 text-muted-foreground"
      />
      {RANGES.map((r) => (
        <Link
          key={r}
          href={hrefWith(pathname, params, {
            range: r,
            before: undefined,
            page: undefined,
          })}
          onClick={() => {
            document.cookie = rangeCookie(r);
          }}
          aria-current={r === current ? "true" : undefined}
          scroll={false}
          className={cn(
            "rounded px-2 py-0.5 text-xs whitespace-nowrap",
            r === current
              ? "bg-secondary font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t(`short.${r}`)}
          <span className="sr-only">{` (${t(`ranges.${r}`)})`}</span>
        </Link>
      ))}
    </div>
  );
}
