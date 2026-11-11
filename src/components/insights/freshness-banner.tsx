import { getFormatter, getTranslations } from "next-intl/server";
import { SyncNowButton } from "@/components/sync-now-button";
import { staleReasons } from "@/lib/insights-view";
import type { Freshness } from "@/server/data/insights";

/**
 * Data freshness (design §7): a pill with the age of the last webhook and
 * the last reconcile, and a stale banner with its reasons. The lazy
 * reconcile itself is started by the account layout; `refreshing` says it
 * was just started for this view. Operators and admins get Sync now.
 */
export async function FreshnessBanner({
  freshness,
  installationId,
  refreshing,
  canSync,
  now = new Date(),
}: {
  freshness: Freshness;
  installationId: string;
  refreshing: boolean;
  canSync: boolean;
  now?: Date;
}) {
  const t = await getTranslations("freshness");
  const format = await getFormatter();
  const ago = (iso: string | null) =>
    iso ? format.relativeTime(new Date(iso), now) : t("never");
  const reasons = staleReasons(freshness, now);

  return (
    <section
      aria-label={t("label")}
      className={
        reasons.length > 0
          ? "flex flex-col gap-2 rounded-xl border border-destructive/50 bg-destructive/5 p-3 text-sm"
          : "flex flex-col gap-2 text-sm"
      }
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="rounded-full border px-3 py-1 text-xs text-muted-foreground">
          {t("pill", {
            webhook: ago(freshness.lastWebhookAt),
            reconcile: ago(freshness.lastReconciledAt),
          })}
        </span>
        {refreshing ? (
          <span className="text-xs text-muted-foreground">
            {t("refreshing")}
          </span>
        ) : null}
        {canSync ? <SyncNowButton installationId={installationId} /> : null}
      </div>
      {reasons.length > 0 ? (
        <div>
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
      ) : null}
    </section>
  );
}
