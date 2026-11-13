import { Rocket } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { formatNumber, formatPercent } from "@/lib/format";
import { dailyAllotment } from "@/lib/hosting-view";
import type { AttentionItem, DeploymentInsights } from "@/server/data/vercel";
import { NeedsAttention, type HostingActions } from "./hosting";

/**
 * The Hosting card of the account overview (design addendum §9, W1/W8):
 * production health and the plan's daily allotment at a glance, plus the
 * Needs-attention list (failing production, auto-assign paused, token
 * expiring or rejected), each linking to where it is fixed.
 */
export async function HostingCard({
  login,
  teamSlug,
  plan,
  insights,
  attention,
  rangeLabel,
  settingsHref,
  actions,
}: {
  login: string;
  teamSlug: string;
  plan: string | null;
  insights: DeploymentInsights;
  attention: ReadonlyArray<AttentionItem>;
  rangeLabel: string;
  settingsHref?: string;
  /** Promote on "auto-assign paused" for operators (W4). */
  actions?: HostingActions;
}) {
  const [t, locale] = await Promise.all([
    getTranslations("hosting"),
    getLocale(),
  ]);
  const base = `/o/${encodeURIComponent(login)}`;
  const cap = dailyAllotment(plan);
  const stat = (label: string, value: string, href?: string, alert = false) => (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          alert
            ? "text-lg font-semibold text-status-critical"
            : "text-lg font-semibold"
        }
      >
        {href ? (
          <Link href={href} className="underline-offset-2 hover:underline">
            {value}
          </Link>
        ) : (
          value
        )}
      </dd>
    </div>
  );
  return (
    <section
      aria-labelledby="hosting-card"
      className="grid gap-4 rounded-xl border bg-card p-4 text-card-foreground lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 id="hosting-card" className="flex items-center gap-2 font-medium">
            <Rocket
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
            {t("card.title")}
          </h2>
          <Link
            href={`${base}/deployments`}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("card.showAll")}
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("card.subtitle", { team: teamSlug, range: rangeLabel })}
        </p>
        <dl className="grid grid-cols-2 gap-3">
          {stat(
            t("kpi.failingProd"),
            formatNumber(insights.failingProjects, locale),
            insights.failingProjects > 0
              ? `${base}/projects?f=failing`
              : undefined,
            insights.failingProjects > 0,
          )}
          {stat(
            t("kpi.prodSuccess"),
            formatPercent(insights.prodSuccessRate, locale),
            `${base}/deployments?f=production`,
          )}
          {stat(
            t("kpi.deployments"),
            formatNumber(insights.production + insights.preview, locale),
            `${base}/deployments`,
          )}
          {stat(
            cap ? t("kpi.quota") : t("kpi.last24h"),
            cap
              ? `${formatNumber(insights.last24h, locale)} / ${formatNumber(cap, locale)}`
              : formatNumber(insights.last24h, locale),
          )}
        </dl>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t("attention.title")}{" "}
          <span className="tabular-nums">({attention.length})</span>
        </h3>
        <NeedsAttention
          items={attention}
          login={login}
          settingsHref={settingsHref}
          actions={actions}
        />
      </div>
    </section>
  );
}
