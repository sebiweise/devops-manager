import { X } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { CONCLUSION_FILTERS } from "@/lib/insights-view";

/**
 * GET form for the run list filters (branch, event, conclusion, actor): one
 * compact row with visible labels, and "Clear filters" while any is set.
 */
export async function RunFilters({
  action,
  hidden,
  values,
  clearHref,
}: {
  action: string;
  hidden: Record<string, string>;
  values: {
    branch?: string;
    event?: string;
    conclusion?: string;
    actor?: string;
  };
  clearHref?: string;
}) {
  const t = await getTranslations();
  const input =
    "h-8 w-32 rounded-md border bg-background px-2 text-sm placeholder:text-muted-foreground";
  const label = "flex items-center gap-1.5 text-xs text-muted-foreground";
  return (
    <form
      action={action}
      method="get"
      aria-label={t("runs.filters")}
      className="flex flex-wrap items-center gap-x-3 gap-y-2"
    >
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <label className={label}>
        {t("runs.branch")}
        <input
          name="branch"
          defaultValue={values.branch ?? ""}
          className={input}
        />
      </label>
      <label className={label}>
        {t("runs.event")}
        <input
          name="event"
          defaultValue={values.event ?? ""}
          placeholder="push"
          className={input}
        />
      </label>
      <label className={label}>
        {t("runs.conclusion")}
        <select
          name="conclusion"
          defaultValue={values.conclusion ?? ""}
          className={input}
        >
          <option value="">{t("runs.any")}</option>
          {CONCLUSION_FILTERS.map((c) => (
            <option key={c} value={c}>
              {t(`status.${c}`)}
            </option>
          ))}
        </select>
      </label>
      <label className={label}>
        {t("runs.actor")}
        <input
          name="actor"
          defaultValue={values.actor ?? ""}
          className={input}
        />
      </label>
      <Button type="submit" size="sm" variant="outline">
        {t("repos.apply")}
      </Button>
      {clearHref ? (
        <Link
          href={clearHref}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          <X aria-hidden="true" className="size-3" />
          {t("table.clearFilters")}
        </Link>
      ) : null}
    </form>
  );
}
