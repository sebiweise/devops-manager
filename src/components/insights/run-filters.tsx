import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { CONCLUSION_FILTERS } from "@/lib/insights-view";

/** GET form for the run list filters (branch, event, conclusion, actor). */
export async function RunFilters({
  action,
  hidden,
  values,
}: {
  action: string;
  hidden: Record<string, string>;
  values: {
    branch?: string;
    event?: string;
    conclusion?: string;
    actor?: string;
  };
}) {
  const t = await getTranslations();
  const input =
    "h-8 w-36 rounded-md border bg-background px-2 text-sm placeholder:text-muted-foreground";
  return (
    <form
      action={action}
      method="get"
      aria-label={t("runs.filters")}
      className="flex flex-wrap items-end gap-2"
    >
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <label className="flex flex-col gap-1 text-xs">
        {t("runs.branch")}
        <input
          name="branch"
          defaultValue={values.branch ?? ""}
          className={input}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        {t("runs.event")}
        <input
          name="event"
          defaultValue={values.event ?? ""}
          placeholder="push"
          className={input}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
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
      <label className="flex flex-col gap-1 text-xs">
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
    </form>
  );
}
