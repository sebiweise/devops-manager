import { useTranslations } from "next-intl";

/**
 * Loading placeholder of the app pages (UI overhaul §1.12): a header, a row
 * of KPI tiles and eight table rows, announced once as "Loading…".
 */
export function PageSkeleton({ kpis = 4 }: { kpis?: number }) {
  const t = useTranslations("shell");
  const block = "animate-pulse rounded-md bg-muted";
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <p role="status" className="sr-only">
        {t("loading")}
      </p>
      <div className={`${block} h-8 w-56`} />
      <div className={`${block} h-4 w-80`} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: kpis }, (_, i) => (
          <div key={i} className={`${block} h-20`} />
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className={`${block} h-9`} />
        ))}
      </div>
    </div>
  );
}
