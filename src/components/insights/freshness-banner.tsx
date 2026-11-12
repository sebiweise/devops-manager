import { TriangleAlert } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { SyncNowButton } from "@/components/sync-now-button";
import { staleReasons } from "@/lib/insights-view";
import type { Freshness } from "@/server/data/insights";

/**
 * The stale-data notice under the account header (UI overhaul §1.10). In the
 * normal state the freshness chip in the header carries the data age; this
 * banner renders only while stale reasons exist and lists them, with Sync
 * now for operators and admins.
 */
export async function FreshnessBanner({
  freshness,
  installationId,
  canSync,
  now = new Date(),
}: {
  freshness: Freshness;
  installationId: string;
  canSync: boolean;
  now?: Date;
}) {
  const t = await getTranslations("freshness");
  const reasons = staleReasons(freshness, now);
  if (reasons.length === 0) return null;

  return (
    <section
      aria-label={t("label")}
      className="flex flex-wrap items-start gap-3 rounded-xl border border-status-warning/60 bg-status-warning/10 p-3 text-sm"
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-status-warning"
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("staleTitle")}</p>
        <ul className="list-inside list-disc text-muted-foreground">
          {reasons.map((r) => (
            <li key={r}>
              {t(`reasons.${r}`, {
                count: freshness.failedDeliveries + freshness.deadDeliveries,
              })}
            </li>
          ))}
        </ul>
      </div>
      {canSync ? <SyncNowButton installationId={installationId} /> : null}
    </section>
  );
}
