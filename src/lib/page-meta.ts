import "server-only";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";

/**
 * Localized page titles (UI overhaul §1.12): "<section> · <account>",
 * "<repo> · <account>", "Costs November 2026 · <account>". Titles only use
 * URL params, so no tenant data is read before the page's own access check.
 */

export type MetaKey =
  | "dashboard"
  | "overview"
  | "repos"
  | "repo"
  | "workflows"
  | "workflow"
  | "runners"
  | "runner"
  | "queue"
  | "costs"
  | "audit"
  | "pulls"
  | "dependabot"
  | "variables"
  | "variablesBulk"
  | "batch"
  | "settings"
  | "run"
  | "userSettings"
  | "onboarding"
  | "billingAccess"
  | "deployments"
  | "projects"
  | "pipelines"
  | "pipelineRuns"
  | "pipelineRun"
  | "pipelineUsage";

type Params = Promise<Record<string, string | string[] | undefined>>;

const decode = (v: string | string[] | undefined) => {
  const s = Array.isArray(v) ? v[0] : v;
  try {
    return s ? decodeURIComponent(s) : "";
  } catch {
    return s ?? "";
  }
};

/** A plain localized title, e.g. for the dashboard. */
export async function pageTitle(key: MetaKey): Promise<Metadata> {
  const t = await getTranslations("meta");
  return { title: t(key) };
}

/** `generateMetadata` for an `/o/[account]/...` page. */
export function accountMeta(key: MetaKey) {
  return async ({
    params,
    searchParams,
  }: {
    params: Params;
    searchParams?: Params;
  }): Promise<Metadata> => {
    const p = await params;
    const t = await getTranslations("meta");
    const account = decode(p.account);
    if (key === "repo" && p.repo)
      return { title: `${decode(p.repo)} · ${account}` };
    if (key === "workflow" && p.repo)
      return { title: `${t("workflow")} · ${decode(p.repo)} · ${account}` };
    if (key === "costs") {
      const sp = searchParams ? await searchParams : {};
      const m = /^(\d{4})-(\d{2})$/.exec(decode(sp.month));
      const date = m
        ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
        : new Date();
      const month = new Intl.DateTimeFormat(await getLocale(), {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(date);
      return { title: `${t("costs")} ${month} · ${account}` };
    }
    return { title: `${t(key)} · ${account}` };
  };
}
