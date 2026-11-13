import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Info,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { StatusBadge } from "@/components/data/status-badge";
import type { AzureSettings } from "@/server/data/azure";
import { AzureManagementToggle } from "./azure-actions";
import {
  AzureCredentialButton,
  AzureDefinitionButton,
  AzureDisconnectButton,
  AzureHookButton,
  AzureLimitsButton,
  AzureProjectsButton,
} from "./azure-settings";

/**
 * "CI · Azure DevOps" on the account settings (admin, `#azure`, design
 * addendum M7 §3): the prerequisites checklist, the organisation and
 * credential (PAT or service principal, hint, expiry), the capability
 * probes, sync status and freshness mode (polling plus check run hints,
 * optional service hook), the project selection, the definition links, the
 * limits with "detected from Azure DevOps", the service hook and the
 * Azure actions toggle (M7b, off by default).
 */
export async function AzureSection({
  installationId,
  settings,
  globalEnabled,
  azureGlobal,
}: {
  installationId: string;
  settings: AzureSettings;
  globalEnabled: boolean;
  azureGlobal: boolean;
}) {
  const [t, format] = await Promise.all([
    getTranslations("ci.azure.settings"),
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
  const h2 = "scroll-mt-4 text-lg font-semibold";
  const ScopeIcon = ({ v }: { v: string }) =>
    v === "ok" ? (
      <CircleCheck aria-hidden="true" className="size-4 text-status-good" />
    ) : v === "missing" ? (
      <CircleAlert aria-hidden="true" className="size-4 text-status-critical" />
    ) : (
      <CircleHelp aria-hidden="true" className="size-4 text-muted-foreground" />
    );
  return (
    <section aria-labelledby="azure" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="azure" className={h2}>
          {t("title")}
        </h2>
        {globalEnabled ? (
          <div className="flex flex-wrap items-center gap-2">
            {!c ? (
              <AzureCredentialButton
                installationId={installationId}
                mode="connect"
              />
            ) : null}
            {c && c.authKind !== "ENV" ? (
              <AzureCredentialButton
                installationId={installationId}
                mode="rotate"
                orgName={c.orgName}
                currentKind={c.authKind}
              />
            ) : null}
            {c ? (
              <AzureDisconnectButton
                installationId={installationId}
                orgName={c.orgName}
                hasHooks={c.hook.subscriptions.length > 0}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">
        {t("description")}
      </p>
      {!c ? (
        <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
          <h3 className="font-medium">{t("prereq.title")}</h3>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>{t("prereq.pat")}</li>
            <li>{t("prereq.read")}</li>
            <li>{t("prereq.optional")}</li>
            <li>{t("prereq.sp")}</li>
            <li>{t("prereq.inactivity")}</li>
          </ul>
          <p>{t("notConnected")}</p>
        </div>
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
            <dt className="text-muted-foreground">{t("org")}</dt>
            <dd>
              <a
                href={c.orgUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {c.orgName}
              </a>
            </dd>
            <dt className="text-muted-foreground">{t("authKind")}</dt>
            <dd>
              {t(`kind.${c.authKind}`)}
              {c.tokenHint ? (
                <span className="font-mono text-xs text-muted-foreground">
                  {" "}
                  …{c.tokenHint}
                </span>
              ) : null}
              {c.authKind === "ENTRA_SP" && c.clientId ? (
                <span className="block font-mono text-xs text-muted-foreground">
                  {t("clientIdShort", { id: c.clientId })}
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
              {c.hook.subscriptions.length > 0
                ? ` · ${t("freshnessHook")}`
                : ""}
            </dd>
            <dt className="text-muted-foreground">{t("usageFeed")}</dt>
            <dd>
              {c.jobRequestsAvailable === false
                ? t("usagePartial")
                : t("usageFull")}
            </dd>
          </dl>
          {!settings.hintsAvailable ? (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {t("hintsMissing")}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
            <h3 className="font-medium">{t("scopes.title")}</h3>
            <ul className="grid gap-1 sm:grid-cols-2">
              {(
                ["projects", "pools", "builds", "execute", "hooks"] as const
              ).map((s) => (
                <li key={s} className="flex items-center gap-2">
                  <ScopeIcon v={c.scopes[s]} />
                  <span>{t(`scopes.${s}`)}</span>
                  <span className="text-xs text-muted-foreground">
                    {t(
                      `scopeState.${c.scopes[s] === "ok" || c.scopes[s] === "missing" ? c.scopes[s] : "unknown"}`,
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">{t("projectsTitle")}</h3>
              {globalEnabled && settings.projects.length > 0 ? (
                <AzureProjectsButton
                  installationId={installationId}
                  projects={settings.projects}
                />
              ) : null}
            </div>
            {settings.projects.length === 0 ? (
              <p className="text-muted-foreground">{t("noProjects")}</p>
            ) : (
              <ul className="flex flex-col">
                {settings.projects.map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center gap-2 border-t py-1 first:border-t-0"
                  >
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {t(
                        `visibility.${p.visibility === "public" ? "public" : "private"}`,
                      )}
                    </span>
                    <span className="text-xs">
                      {p.selected ? t("selected") : t("notSelected")}
                    </span>
                    {p.selected ? (
                      <span className="text-xs text-muted-foreground">
                        {p.backfillDone ? t("backfillDone") : t("backfilling")}
                        {p.cursor ? ` · ${t("cursor")} ` : ""}
                        {p.cursor ? when(p.cursor) : null}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">{t("limits.title")}</h3>
              {globalEnabled ? (
                <AzureLimitsButton
                  installationId={installationId}
                  limits={c.limits}
                  detected={c.detected}
                />
              ) : null}
            </div>
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">{t("limits.parallel")}</dt>
              <dd>{c.limits.hostedParallelJobs}</dd>
              <dt className="text-muted-foreground">{t("limits.included")}</dt>
              <dd>
                {c.limits.includedMinutes == null
                  ? t("limits.paidValue")
                  : format.number(c.limits.includedMinutes)}
              </dd>
              <dt className="text-muted-foreground">{t("limits.maxJob")}</dt>
              <dd>{t("limits.minutes", { n: c.limits.maxJobMinutes })}</dd>
              <dt className="text-muted-foreground">{t("limits.resetDay")}</dt>
              <dd>{t("limits.resetValue", { day: c.limits.monthResetDay })}</dd>
              <dt className="text-muted-foreground">{t("limits.block")}</dt>
              <dd>
                {c.limits.blockWhenQuotaExhausted
                  ? t("limits.blockOn")
                  : t("limits.blockOff")}
              </dd>
            </dl>
            {c.detected ? (
              <p className="text-muted-foreground">
                {t("limits.detected", {
                  minutes:
                    c.detected.totalMinutes == null
                      ? "—"
                      : format.number(c.detected.totalMinutes),
                  parallel: c.detected.totalCount ?? "—",
                  premium:
                    c.detected.isPremium == null
                      ? "—"
                      : c.detected.isPremium
                        ? t("limits.yes")
                        : t("limits.no"),
                })}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">{t("hooks.heading")}</h3>
              {globalEnabled ? (
                <div className="flex flex-wrap gap-2">
                  <AzureHookButton installationId={installationId} op="auto" />
                  <AzureHookButton
                    installationId={installationId}
                    op="manual"
                  />
                  {c.hook.configured ? (
                    <AzureHookButton
                      installationId={installationId}
                      op="rotate"
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
            <p className="max-w-prose text-muted-foreground">
              {t("hooks.description")}
            </p>
            {c.hook.url ? (
              <p className="font-mono text-xs break-all">{c.hook.url}</p>
            ) : null}
            {c.hook.previousUntil ? (
              <p className="text-xs text-muted-foreground">
                {t("hooks.previousUntil")} {when(c.hook.previousUntil)}
              </p>
            ) : null}
            {c.hook.subscriptions.length > 0 ? (
              <ul className="flex flex-col text-xs">
                {c.hook.subscriptions.map((s) => (
                  <li key={s.id} className="flex flex-wrap gap-2">
                    <span className="font-mono">{s.eventType}</span>
                    <span
                      className={
                        s.status === "enabled"
                          ? "text-muted-foreground"
                          : "text-status-warning"
                      }
                    >
                      {s.status}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 font-medium">
                {c.managementEnabled ? (
                  <ShieldCheck
                    aria-hidden="true"
                    className="size-4 text-status-good"
                  />
                ) : (
                  <ShieldOff
                    aria-hidden="true"
                    className="size-4 text-muted-foreground"
                  />
                )}
                {t("management.title")}
                <span className="font-normal text-muted-foreground">
                  ·{" "}
                  {c.managementEnabled
                    ? t("management.on")
                    : t("management.off")}
                </span>
              </h3>
              {globalEnabled ? (
                <AzureManagementToggle
                  installationId={installationId}
                  orgName={c.orgName}
                  enabled={c.managementEnabled}
                />
              ) : null}
            </div>
            <p className="max-w-prose text-muted-foreground">
              {t("management.description")}
            </p>
            {!azureGlobal ? (
              <p className="text-muted-foreground">{t("management.envOff")}</p>
            ) : null}
          </div>
          {settings.definitions.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="font-medium">{t("linksTitle")}</h3>
              <p className="max-w-prose text-sm text-muted-foreground">
                {t("linksDescription")}
              </p>
              <ul className="flex flex-col">
                {settings.definitions.map((d) => {
                  const repo = (rid: string | null) =>
                    rid
                      ? settings.repositories.find((r) => r.id === rid)
                          ?.fullName
                      : null;
                  const manual = repo(d.manualRepositoryId);
                  const auto = repo(d.repositoryId);
                  return (
                    <li
                      key={`${d.projectId}:${d.id}`}
                      className="flex flex-wrap items-center gap-2 border-t py-1.5 text-sm first:border-t-0"
                    >
                      <span className="font-medium">{d.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {d.projectName}
                      </span>
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
                          {d.linkRepo
                            ? t("linkOutside", { repo: d.linkRepo })
                            : t("linkNone", { type: d.repoType })}
                        </span>
                      )}
                      {d.osOverride ? (
                        <span className="text-xs text-muted-foreground">
                          {t(`os.${d.osOverride}`)}
                        </span>
                      ) : null}
                      {globalEnabled ? (
                        <span className="ml-auto">
                          <AzureDefinitionButton
                            installationId={installationId}
                            definition={{
                              projectId: d.projectId,
                              id: d.id,
                              name: d.name,
                              manualRepositoryId: d.manualRepositoryId,
                              osOverride: d.osOverride,
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
          <p className="text-sm text-muted-foreground">{t("rbacNote")}</p>
        </div>
      )}
    </section>
  );
}
