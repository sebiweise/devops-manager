"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Frame of every chart (design §7): a `<figure>` with a `<figcaption>`, and
 * a "Show as table" toggle that swaps the chart for a table of the same
 * data. The chart itself carries `role="img"` and an `aria-label`.
 */
export function ChartFrame({
  title,
  description,
  chart,
  table,
  legend,
  className,
}: {
  title: string;
  description?: string;
  chart: React.ReactNode;
  table: React.ReactNode;
  legend?: React.ReactNode;
  className?: string;
}) {
  const t = useTranslations("charts");
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  const captionId = `${id}-caption`;
  const bodyId = `${id}-body`;

  return (
    <figure
      aria-labelledby={captionId}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <figcaption id={captionId} className="flex flex-col gap-0.5">
          <span className="font-medium">{title}</span>
          {description ? (
            <span className="text-xs text-muted-foreground">{description}</span>
          ) : null}
        </figcaption>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-controls={bodyId}
          aria-pressed={asTable}
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? t("showChart") : t("showTable")}
        </Button>
      </div>
      <div id={bodyId} className="min-w-0">
        {asTable ? (
          table
        ) : (
          <>
            {chart}
            {legend}
          </>
        )}
      </div>
    </figure>
  );
}
