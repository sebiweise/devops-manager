import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { RangeFilter } from "@/components/insights/range-filter";
import { RunFilters } from "@/components/insights/run-filters";
import { RunsTable } from "@/components/insights/runs-table";
import { repoHref } from "@/components/insights/workflow-link";
import { WorkflowsTable } from "@/components/insights/workflows-table";
import { accountPath, loadAccount, orNotFound } from "@/lib/account-page";
import {
  decodeCursor,
  encodeCursor,
  param,
  parseConclusion,
  textFilter,
  withParams,
  type SearchParams,
} from "@/lib/insights-view";
import { cn } from "@/lib/utils";
import {
  findRepositoryByName,
  listRuns,
  listWorkflowStats,
  parseRange,
} from "@/server/data/insights";

export const metadata = { title: "Repository" };

const TABS = ["workflows", "runs"] as const;

export default async function RepoPage({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; repo: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { account, repo: repoParam } = await params;
  const sp = await searchParams;
  const { scope, installation } = await loadAccount(account);
  const repo = await findRepositoryByName(
    scope,
    installation.id,
    decodeURIComponent(repoParam),
  );
  if (!repo) notFound();

  const t = await getTranslations();
  const login = installation.accountLogin;
  const base = repoHref(login, repo.fullName);
  const tab = param(sp, "tab") === "runs" ? "runs" : "workflows";
  const range = parseRange(param(sp, "range") ?? "30d");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={accountPath(login, "/repos")} className="underline">
            {t("repos.title")}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">{repo.fullName}</h1>
        <p className="text-sm text-muted-foreground">
          {t("repo.defaultBranch", { branch: repo.defaultBranch })} ·{" "}
          <a
            className="underline"
            href={`https://github.com/${repo.fullName}/actions`}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t("repo.openOnGithub")}
          </a>
        </p>
      </div>

      <nav aria-label={t("repo.tabs")} className="flex gap-1 border-b">
        {TABS.map((key) => (
          <Link
            key={key}
            href={withParams(
              base,
              {},
              { tab: key === "workflows" ? undefined : key },
            )}
            aria-current={tab === key ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              tab === key
                ? "border-primary font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`repo.tab.${key}`)}
          </Link>
        ))}
      </nav>
      <p className="text-xs text-muted-foreground">{t("repo.laterTabs")}</p>

      {tab === "workflows" ? (
        <WorkflowsTab
          scope={scope}
          installationId={installation.id}
          repositoryId={BigInt(repo.id)}
          login={login}
          base={base}
          range={range}
          sp={sp}
        />
      ) : (
        <RunsTab
          scope={scope}
          installationId={installation.id}
          repositoryId={BigInt(repo.id)}
          login={login}
          base={base}
          sp={sp}
        />
      )}
    </div>
  );
}

type TabProps = {
  scope: Awaited<ReturnType<typeof loadAccount>>["scope"];
  installationId: bigint;
  repositoryId: bigint;
  login: string;
  base: string;
  sp: SearchParams;
};

async function WorkflowsTab({
  scope,
  installationId,
  repositoryId,
  login,
  base,
  range,
  sp,
}: TabProps & { range: ReturnType<typeof parseRange> }) {
  const t = await getTranslations();
  const stats = await orNotFound(
    listWorkflowStats(scope, installationId, { repositoryId, range }),
  );
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{t("repo.tab.workflows")}</h2>
        <RangeFilter base={base} current={range} searchParams={sp} />
      </div>
      <WorkflowsTable
        accountLogin={login}
        stats={stats}
        caption={t("repo.tab.workflows")}
      />
    </section>
  );
}

async function RunsTab({
  scope,
  installationId,
  repositoryId,
  login,
  base,
  sp,
}: TabProps) {
  const t = await getTranslations();
  const values = {
    branch: textFilter(param(sp, "branch")),
    event: textFilter(param(sp, "event")),
    conclusion: parseConclusion(param(sp, "conclusion")),
    actor: textFilter(param(sp, "actor")),
  };
  const before = decodeCursor(param(sp, "before"));
  const { runs, next } = await orNotFound(
    listRuns(scope, installationId, {
      repositoryId,
      ...values,
      ...(before ? { before } : {}),
      limit: 50,
    }),
  );
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">{t("repo.tab.runs")}</h2>
      <RunFilters action={base} hidden={{ tab: "runs" }} values={values} />
      <RunsTable
        accountLogin={login}
        runs={runs}
        caption={t("repo.tab.runs")}
      />
      <div className="flex gap-3 text-sm">
        {before ? (
          <Link
            className="underline"
            href={withParams(base, sp, { before: undefined })}
          >
            {t("runs.first")}
          </Link>
        ) : null}
        {next ? (
          <Link
            className="underline"
            href={withParams(base, sp, { before: encodeCursor(next) })}
          >
            {t("runs.older")}
          </Link>
        ) : null}
      </div>
    </section>
  );
}
