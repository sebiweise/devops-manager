import { CircleAlert, Info } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { StatusBadge } from "@/components/data/status-badge";
import { dailyAllotment } from "@/lib/hosting-view";
import type { VercelSettings } from "@/server/data/vercel";
import {
  VercelDisconnectButton,
  VercelLinkButton,
  VercelTokenButton,
} from "./vercel-settings";

/**
 * "Hosting · Vercel" on the account settings (admin, design addendum §9):
 * the team, plan, token source and hint, expiry, sync status and last error,
 * the rate-limit reset, Connect/Rotate/Disconnect, the freshness mode
 * (polling + GitHub hints, with a hint when the App lacks
 * `deployments: read`), the static plan limits and the manual project links.
 * The app roles are the only authorisation layer over the one Vercel token.
 */
export async function VercelSection({
  installationId,
  settings,
  globalEnabled,
}: {
  installationId: string;
  settings: VercelSettings;
  globalEnabled: boolean;
}) {
  const [t, format] = await Promise.all([
    getTranslations("vercelSettings"),
    getFormatter(),
  ]);
  const c = settings.connection;
  const when = (iso: string | null) =>
    iso ? (
      <time
        dateTime={iso}
        title={format.dateTime(new Date(iso), {
          dateStyle: "medium",
          timeStyle: "short",
        })}
      >
        {format.relativeTime(new Date(iso))}
      </time>
    ) : (
      t("never")
    );
  const date = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium" });
  const cap = dailyAllotment(c?.plan);
  const h2 = "scroll-mt-4 text-lg font-semibold";
  return (
    <section aria-labelledby="hosting" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="hosting" className={h2}>
          {t("title")}
        </h2>
        {globalEnabled ? (
          <div className="flex flex-wrap items-center gap-2">
            {!c ? (
              <VercelTokenButton
                installationId={installationId}
                mode="connect"
              />
            ) : null}
            {c && c.tokenSource === "DB" ? (
              <VercelTokenButton
                installationId={installationId}
                mode="rotate"
              />
            ) : null}
            {c ? (
              <VercelDisconnectButton
                installationId={installationId}
                teamSlug={c.teamSlug}
                envManaged={c.tokenSource === "ENV"}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">
        {t("description")}
      </p>

      {!c ? (
        <p className="text-sm">{t("notConnected")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {c.revokedAt ? (
            <p
              role="status"
              className="flex items-start gap-2 rounded-md border border-status-critical/50 bg-status-critical/10 p-2 text-sm"
            >
              <CircleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-status-critical"
              />
              {t("revoked", { when: date(c.revokedAt) })}
            </p>
          ) : null}
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t("team")}</dt>
            <dd>
              {c.teamName}{" "}
              <span className="font-mono text-xs text-muted-foreground">
                ({c.teamSlug})
              </span>
            </dd>
            <dt className="text-muted-foreground">{t("plan")}</dt>
            <dd>
              {c.plan
                ? t(
                    `plans.${c.plan === "hobby" || c.plan === "pro" || c.plan === "enterprise" ? c.plan : "other"}`,
                  )
                : "—"}
            </dd>
            <dt className="text-muted-foreground">{t("tokenSource")}</dt>
            <dd>
              {c.tokenSource === "ENV" ? t("sourceEnv") : t("sourceDb")}
              {c.tokenHint ? (
                <span className="font-mono text-xs text-muted-foreground">
                  {" "}
                  …{c.tokenHint}
                </span>
              ) : null}
              {c.tokenScope === "full" ? (
                <span className="ml-2 text-xs text-status-warning">
                  {t("scopeFull")}
                </span>
              ) : c.tokenScope === "team" ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  {t("scopeTeam")}
                </span>
              ) : null}
            </dd>
            <dt className="text-muted-foreground">{t("expires")}</dt>
            <dd>{c.tokenExpiresAt ? date(c.tokenExpiresAt) : t("noExpiry")}</dd>
            <dt className="text-muted-foreground">{t("lastSync")}</dt>
            <dd>
              {t(`status.${c.lastSyncStatus ?? "never"}`)} ·{" "}
              {when(c.lastSyncedAt)}
            </dd>
            {c.lastError ? (
              <>
                <dt className="text-muted-foreground">{t("lastError")}</dt>
                <dd className="break-words">{c.lastError}</dd>
              </>
            ) : null}
            {c.pausedUntil ? (
              <>
                <dt className="text-muted-foreground">{t("pausedUntil")}</dt>
                <dd>{when(c.pausedUntil)}</dd>
              </>
            ) : null}
            {settings.rateLimit ? (
              <>
                <dt className="text-muted-foreground">{t("rateLimit")}</dt>
                <dd>
                  {t("rateLimitValue", {
                    remaining: settings.rateLimit.remaining,
                    limit: settings.rateLimit.limit,
                  })}{" "}
                  · {when(settings.rateLimit.resetAt)}
                </dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{t("freshness")}</dt>
            <dd>
              {settings.hintsAvailable
                ? t("freshnessHints")
                : t("freshnessPolling")}
            </dd>
          </dl>
          {!settings.hintsAvailable ? (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {t("hintsMissing")}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">{t("rbacNote")}</p>
          <div className="rounded-lg border p-3 text-sm">
            <h3 className="font-medium">{t("limits.title")}</h3>
            <p className="text-muted-foreground">
              {cap ? t("limits.deployments", { cap }) : t("limits.custom")}{" "}
              {t("limits.note")}
            </p>
          </div>
          {settings.projects.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="font-medium">{t("linksTitle")}</h3>
              <p className="max-w-prose text-sm text-muted-foreground">
                {t("linksDescription")}
              </p>
              <ul className="flex flex-col">
                {settings.projects.map((p) => {
                  const manual = p.manualRepositoryId
                    ? settings.repositories.find(
                        (r) => r.id === p.manualRepositoryId,
                      )?.fullName
                    : null;
                  const auto = p.repositoryId
                    ? settings.repositories.find((r) => r.id === p.repositoryId)
                        ?.fullName
                    : null;
                  return (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center gap-2 border-t py-1.5 text-sm first:border-t-0"
                    >
                      <span className="font-medium">{p.name}</span>
                      <span className="text-muted-foreground">→</span>
                      {manual ? (
                        <>
                          <span>{manual}</span>
                          <StatusBadge kind="manualLink" />
                        </>
                      ) : auto ? (
                        <span>{auto}</span>
                      ) : (
                        <span className="text-muted-foreground">
                          {p.linkRepo
                            ? t("linkOutside", { repo: p.linkRepo })
                            : t("linkNone")}
                        </span>
                      )}
                      {globalEnabled ? (
                        <span className="ml-auto">
                          <VercelLinkButton
                            installationId={installationId}
                            project={{
                              id: p.id,
                              name: p.name,
                              manualRepositoryId: p.manualRepositoryId,
                            }}
                            repositories={settings.repositories}
                          />
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
