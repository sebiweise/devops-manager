import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { withParams, type SearchParams } from "@/lib/insights-view";
import { cn } from "@/lib/utils";
import { RANGES, type InsightRange } from "@/server/data/insights";

/** Range filter persisted in the URL (`?range=`), plain links. */
export async function RangeFilter({
  base,
  current,
  searchParams,
}: {
  base: string;
  current: InsightRange;
  searchParams: SearchParams;
}) {
  const t = await getTranslations("filters");
  return (
    <nav aria-label={t("range")} className="flex flex-wrap gap-1">
      {RANGES.map((r) => (
        <Link
          key={r}
          href={withParams(base, searchParams, { range: r, before: undefined })}
          aria-current={r === current ? "true" : undefined}
          className={cn(
            "rounded-md border px-2.5 py-1 text-xs",
            r === current
              ? "bg-primary text-primary-foreground"
              : "hover:bg-accent",
          )}
        >
          {t(`ranges.${r}`)}
        </Link>
      ))}
    </nav>
  );
}
