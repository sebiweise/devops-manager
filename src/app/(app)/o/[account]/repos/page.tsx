import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Sparkline } from "@/components/charts/sparkline";
import { StatusBadge } from "@/components/insights/status-badge";
import { repoHref, runHref } from "@/components/insights/workflow-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import {
  formatDuration,
  formatMinutes,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import {
  param,
  parseRepoSort,
  sortRepoStats,
  withParams,
  type RepoSort,
  type SearchParams,
} from "@/lib/insights-view";
import { listRepoStats } from "@/server/data/insights";
import { liveRepositories } from "@/server/data/live-repositories";

export const metadata = { title: "Repositories" };

/** Where the installation's repository selection is changed on GitHub. */
function selectionUrl(login: string, type: "USER" | "ORGANIZATION") {
  return type === "ORGANIZATION"
    ? `https://github.com/organizations/${encodeURIComponent(login)}/settings/installations`
    : "https://github.com/settings/installations";
}

export default async function ReposPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account } = await params;
  const sp = await searchParams;
  const { scope, installation } = await loadAccount(account);
  // Refreshes the stored inventory from GitHub (falls back to stored rows).
  const { source } = await orNotFound(liveRepositories(scope, installation));
  const [t, locale, stats] = await Promise.all([
    getTranslations(),
    getLocale(),
    orNotFound(listRepoStats(scope, installation.id)),
  ]);
  const sort = parseRepoSort(param(sp, "sort"));
  const dir = param(sp, "dir") === "desc" ? "desc" : "asc";
  const q = param(sp, "q");
  const rows = sortRepoStats(stats, sort, dir, q);
  const login = installation.accountLogin;
  const base = accountPath(login, "/repos");

  const header = (key: RepoSort, label: string, numeric = false) => {
    const active = sort === key;
    const next = active && dir === "asc" ? "desc" : "asc";
    return (
      <TableHead
        aria-sort={
          active ? (dir === "asc" ? "ascending" : "descending") : undefined
        }
        className={numeric ? "text-right" : undefined}
      >
        <Link
          href={withParams(base, sp, { sort: key, dir: next })}
          className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
        >
          {label}
          {active ? (
            <span aria-hidden="true">{dir === "asc" ? "▲" : "▼"}</span>
          ) : null}
        </Link>
      </TableHead>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("repos.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("dashboard.repositories", { count: stats.length })}
            {" · "}
            {source === "live"
              ? t("dashboard.liveSource")
              : t("dashboard.storedSource")}
          </p>
        </div>
        <form action={base} method="get" role="search" className="flex gap-2">
          {sort !== "name" ? (
            <input type="hidden" name="sort" value={sort} />
          ) : null}
          {dir !== "asc" ? (
            <input type="hidden" name="dir" value={dir} />
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">{t("repos.filter")}</span>
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder={t("repos.filter")}
              className="h-8 rounded-md border bg-background px-2 text-sm"
            />
          </label>
          <Button type="submit" size="sm" variant="outline">
            {t("repos.apply")}
          </Button>
        </form>
      </div>

      {stats.length === 0 ? (
        <p className="text-muted-foreground">
          {t("account.noRepos")}{" "}
          <a
            className="underline"
            href={selectionUrl(login, installation.accountType)}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t("repos.changeSelection")}
          </a>
        </p>
      ) : (
        <Table>
          <caption className="sr-only">{t("repos.title")}</caption>
          <TableHeader>
            <TableRow>
              {header("name", t("repos.repo"))}
              {header("lastRun", t("repos.lastRun"))}
              {header("runs", t("repos.runs7d"), true)}
              {header("success", t("repos.success7d"), true)}
              {header("p50", t("repos.p50"), true)}
              {header("minutes", t("repos.minutes30d"), true)}
              <TableHead>{t("repos.trend")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const runs = r.sparkline.reduce((s, p) => s + p.runs, 0);
              const failures = r.sparkline.reduce((s, p) => s + p.failures, 0);
              return (
                <TableRow key={r.repositoryId}>
                  <TableCell className="font-medium">
                    <Link
                      href={repoHref(login, r.fullName)}
                      className="mr-2 underline-offset-2 hover:underline"
                    >
                      {r.fullName}
                    </Link>
                    {r.private ? (
                      <Badge variant="secondary">{t("common.private")}</Badge>
                    ) : null}
                    {r.archived ? (
                      <Badge variant="outline" className="ml-1">
                        {t("common.archived")}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {r.lastRun ? (
                      <Link
                        href={runHref(login, r.lastRun.id)}
                        className="flex items-center gap-2"
                      >
                        <StatusBadge
                          status={r.lastRun.status}
                          conclusion={r.lastRun.conclusion}
                        />
                        <span className="max-w-40 truncate text-xs text-muted-foreground">
                          {r.lastRun.workflowName}
                        </span>
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">
                        {t("repos.noRuns")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(r.runs7d, locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPercent(r.successRate7d, locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(r.p50Duration7d)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMinutes(r.billableMinEst30d, locale)}
                  </TableCell>
                  <TableCell>
                    <Sparkline
                      id={`spark-${r.repositoryId}`}
                      label={t("repos.sparkline", { runs, failures })}
                      points={r.sparkline}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {stats.length > 0 && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("repos.noMatch")}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("repos.minutesNote")}</p>
    </div>
  );
}
