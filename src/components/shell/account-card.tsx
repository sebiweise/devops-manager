import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Building2,
  CircleX,
  Minus,
  TriangleAlert,
  User,
} from "lucide-react";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Sparkline } from "@/components/charts/sparkline";
import { workflowHref } from "@/components/insights/workflow-link";
import { accountPath } from "@/lib/account-page";
import { formatNumber, formatPercent, formatPointsDelta } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AccountSummary } from "@/server/data/summaries";
import { GettingStarted } from "./getting-started";
import { compareCodeUnits } from "@/lib/compare";

function Mini({
  label,
  value,
  children,
}: {
  label: string;
  value: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold">{value}</dd>
      {children ? (
        <dd className="text-xs text-muted-foreground">{children}</dd>
      ) : null}
    </div>
  );
}

/**
 * One account on the start page (UI overhaul §2.1). The whole card opens
 * the account overview (a stretched link on the title); the KPI row, the
 * 14-day trend, the counts, up to three "needs attention" workflows and the
 * section links sit above it with their own links.
 */
export async function AccountCard({
  summary: s,
  settingsHref,
  now,
}: {
  summary: AccountSummary;
  settingsHref?: string;
  now: Date;
}) {
  const [t, tc, locale, format] = await Promise.all([
    getTranslations("dashboard"),
    getTranslations("charts"),
    getLocale(),
    getFormatter(),
  ]);
  const base = accountPath(s.accountLogin);
  const updated = [s.lastWebhookAt, s.lastReconciledAt]
    .filter((v): v is string => !!v)
    .sort(compareCodeUnits)
    .pop();
  const noRuns = s.sparkline.every((p) => p.runs === 0) && s.runs7d === 0;
  const spark = s.sparkline.reduce(
    (a, p) => ({ runs: a.runs + p.runs, failures: a.failures + p.failures }),
    { runs: 0, failures: 0 },
  );
  const ratio =
    s.minutes.included > 0 ? s.minutes.used / s.minutes.included : null;
  const DeltaIcon =
    s.successDelta == null || s.successDelta === 0
      ? Minus
      : s.successDelta > 0
        ? ArrowUp
        : ArrowDown;
  const link = "relative z-10 underline-offset-2 hover:underline";
  const counts: Array<{ href: string; text: string }> = [
    {
      href: `${base}/repos`,
      text: t("counts.repos", { count: s.repositories }),
    },
    ...(s.ignored > 0
      ? [
          {
            href: `${base}/repos?f=ignored`,
            text: t("counts.ignored", { count: s.ignored }),
          },
        ]
      : []),
    ...(s.runnersOffline > 0
      ? [
          {
            href: `${base}/runners?f=offline`,
            text: t("counts.offline", { count: s.runnersOffline }),
          },
        ]
      : []),
    ...(s.failingWorkflows > 0
      ? [
          {
            href: `${base}/workflows?sort=success&dir=asc`,
            text: t("counts.failing", { count: s.failingWorkflows }),
          },
        ]
      : []),
  ];
  const TypeIcon = s.accountType === "ORGANIZATION" ? Building2 : User;

  return (
    <article className="relative flex flex-col gap-4 rounded-xl border bg-card p-5 text-card-foreground transition-colors focus-within:ring-2 focus-within:ring-ring hover:border-foreground/30">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <TypeIcon
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
            />
            <Link
              href={base}
              aria-label={t("openNamed", { name: s.accountLogin })}
              className="truncate outline-none after:absolute after:inset-0 after:rounded-xl"
            >
              {s.accountLogin}
            </Link>
            <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
              {s.accountType === "ORGANIZATION"
                ? t("type.ORGANIZATION")
                : t("type.USER")}
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">
            {updated
              ? t("updated", {
                  ago: format.relativeTime(new Date(updated), now),
                })
              : t("notUpdated")}
          </p>
        </div>
        <ArrowRight
          aria-hidden="true"
          className="mt-1 size-4 shrink-0 text-muted-foreground"
        />
      </header>

      {noRuns ? (
        <div className="relative z-10">
          <GettingStarted
            importProgress={s.importProgress}
            webhookReceived={!!s.lastWebhookAt}
            settingsHref={settingsHref}
          />
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Mini
              label={t("kpi.runs")}
              value={formatNumber(s.runs7d, locale)}
            />
            <Mini
              label={t("kpi.success")}
              value={formatPercent(s.successRate7d, locale)}
            >
              {s.successDelta != null ? (
                <span className="inline-flex items-center gap-0.5">
                  <DeltaIcon
                    aria-hidden="true"
                    className={cn(
                      "size-3",
                      s.successDelta > 0 && "text-status-good",
                      s.successDelta < 0 && "text-status-critical",
                    )}
                  />
                  {formatPointsDelta(s.successDelta, locale)}
                </span>
              ) : null}
            </Mini>
            <Mini
              label={t("kpi.queued")}
              value={formatNumber(s.queuedNow, locale)}
            >
              {s.queuedStuck > 0 ? (
                <Link
                  href={`${base}/queue?f=stuck`}
                  className={cn(link, "inline-flex items-center gap-0.5")}
                >
                  <TriangleAlert
                    aria-hidden="true"
                    className="size-3 text-status-warning"
                  />
                  {t("kpi.stuck", { count: s.queuedStuck })}
                </Link>
              ) : null}
            </Mini>
            <Mini
              label={t("kpi.minutes")}
              value={formatNumber(s.minutes.used, locale)}
            >
              {ratio != null ? (
                <span className="flex flex-col gap-1">
                  <span
                    role="meter"
                    aria-label={t("kpi.minutes")}
                    aria-valuemin={0}
                    aria-valuemax={s.minutes.included}
                    aria-valuenow={s.minutes.used}
                    className="block h-1 overflow-hidden rounded-full bg-seq-1/40"
                  >
                    <span
                      className={cn(
                        "block h-full rounded-full",
                        ratio > 1 ? "bg-status-critical" : "bg-seq-3",
                      )}
                      style={{
                        width: `${Math.round(Math.min(1, ratio) * 100)}%`,
                      }}
                    />
                  </span>
                  {t(
                    s.minutes.source === "estimate"
                      ? "kpi.minutesOfEst"
                      : "kpi.minutesOf",
                    { included: formatNumber(s.minutes.included, locale) },
                  )}
                  {ratio > 1 ? (
                    <span className="inline-flex items-center gap-0.5 font-medium text-foreground">
                      <TriangleAlert
                        aria-hidden="true"
                        className="size-3 text-status-critical"
                      />
                      {t("kpi.over")}
                    </span>
                  ) : null}
                </span>
              ) : s.minutes.source === "estimate" ? (
                t("kpi.est")
              ) : null}
            </Mini>
          </dl>
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">{t("trend")}</p>
            <Sparkline
              id={`acct-${s.installationId}`}
              label={tc("sparkTitle", spark)}
              points={s.sparkline}
              width={280}
              height={32}
              fill
            />
          </div>
        </>
      )}

      <p className="flex flex-wrap gap-x-2 gap-y-1 text-sm text-muted-foreground">
        {counts.map((c, i) => (
          <span key={c.href} className="inline-flex gap-2">
            <Link href={c.href} className={link}>
              {c.text}
            </Link>
            {i < counts.length - 1 ? <span aria-hidden="true">·</span> : null}
          </span>
        ))}
      </p>

      {s.attention.length > 0 ? (
        <section
          aria-label={t("attentionOf", { name: s.accountLogin })}
          className="flex flex-col gap-1.5"
        >
          <h3 className="text-xs font-medium text-muted-foreground">
            {t("attention")}
          </h3>
          <ul className="flex flex-col gap-1 text-sm">
            {s.attention.map((a) => (
              <li
                key={a.workflowId}
                className="flex items-center justify-between gap-2"
              >
                <Link
                  href={workflowHref(
                    s.accountLogin,
                    a.repoFullName,
                    a.workflowId,
                  )}
                  className={cn(
                    link,
                    "inline-flex min-w-0 items-center gap-1.5",
                  )}
                >
                  <CircleX
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-status-critical"
                  />
                  <span className="truncate">
                    {a.workflowName}
                    <span className="text-muted-foreground">
                      {" · "}
                      {a.repoFullName.split("/").pop()}
                    </span>
                  </span>
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t("attentionItem", { count: a.failures })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <nav
          aria-label={t("quickLinks", { name: s.accountLogin })}
          className="flex flex-wrap gap-x-3 gap-y-1 text-sm"
        >
          {(["repos", "runners", "queue", "costs"] as const).map((k) => (
            <Link key={k} href={`${base}/${k}`} className={link}>
              {t(`sections.${k}`)}
            </Link>
          ))}
        </nav>
        <span
          aria-hidden="true"
          className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
        >
          {t("open")}
          <ArrowRight className="size-3.5" />
        </span>
      </footer>
    </article>
  );
}
