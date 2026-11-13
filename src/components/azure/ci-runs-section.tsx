import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { DataTable, type Column } from "@/components/data/data-table";
import { EmptyState } from "@/components/data/empty-state";
import { CursorFooter } from "@/components/data/pagination";
import { RunStatusBadge } from "@/components/data/status-badge";
import { RunFilters } from "@/components/insights/run-filters";
import { runHref, workflowHref } from "@/components/insights/workflow-link";
import { RunActions } from "@/components/management/run-actions";
import { orNotFound } from "@/lib/account-page";
import { CI_FACETS, parseCiFacet } from "@/lib/azure-view";
import { formatDuration } from "@/lib/format";
import {
  param,
  parseConclusion,
  textFilter,
  withParams,
  type SearchParams,
} from "@/lib/insights-view";
import { cn } from "@/lib/utils";
import type { TenantScope } from "@/server/authz/scope";
import { listCiRuns, type CiRun } from "@/server/data/ci-runs";
import { SourceBadge } from "./azure-badges";
import { azureHrefs } from "./azure-views";

const PAGE = 50;

function encode(c: { createdAt: string; key: string }): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decode(
  v: string | undefined,
): { createdAt: string; key: string } | undefined {
  if (!v || v.length > 200) return undefined;
  try {
    const c = JSON.parse(Buffer.from(v, "base64url").toString("utf8")) as {
      createdAt?: unknown;
      key?: unknown;
    };
    if (
      typeof c.createdAt === "string" &&
      !Number.isNaN(Date.parse(c.createdAt)) &&
      typeof c.key === "string" &&
      /^[ga]\d{20}$/.test(c.key)
    )
      return { createdAt: c.createdAt, key: c.key };
  } catch {
    // ignored
  }
  return undefined;
}

/** The CI facet: All / GitHub Actions / Azure Pipelines (keeps the other params). */
export async function CiFacet({
  base,
  sp,
}: {
  base: string;
  sp: SearchParams;
}) {
  const t = await getTranslations("ci.facet");
  const current = parseCiFacet(param(sp, "ci"));
  return (
    <div
      role="group"
      aria-label={t("label")}
      className="flex flex-wrap gap-1.5"
    >
      {CI_FACETS.map((f) => (
        <Link
          key={f}
          href={withParams(base, sp, {
            ci: f === "all" ? undefined : f,
            before: undefined,
          })}
          aria-pressed={current === f}
          role="button"
          scroll={false}
          className={cn(
            "inline-flex h-7 items-center rounded-full border px-3 text-xs",
            current === f
              ? "border-primary bg-primary text-primary-foreground"
              : "hover:bg-accent",
          )}
        >
          {t(f)}
        </Link>
      ))}
    </div>
  );
}

export async function CiRunsTable({
  login,
  runs,
  caption,
  actions,
  showName = true,
  compact = false,
}: {
  login: string;
  runs: ReadonlyArray<CiRun>;
  caption: string;
  actions?: { installationId: string };
  showName?: boolean;
  /** Narrow cards: run, status, name and duration only. */
  compact?: boolean;
}) {
  const [t, format] = await Promise.all([
    getTranslations("runs"),
    getFormatter(),
  ]);
  const h = azureHrefs(login);
  const href = (r: CiRun) =>
    r.provider === "azure" ? h.run(r.id) : runHref(login, r.id);
  const columns: Column<CiRun>[] = [
    {
      id: "run",
      label: t("run"),
      header: t("run"),
      className: "whitespace-normal",
      cell: (r) => (
        <div className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-baseline gap-x-1.5">
            <Link
              href={href(r)}
              className="font-medium underline-offset-2 hover:underline"
            >
              {r.number != null ? `#${r.number}` : r.id}
            </Link>
            {r.attempt > 1 ? (
              <span className="text-xs text-muted-foreground">
                {t("attempt", { n: r.attempt })}
              </span>
            ) : null}
          </span>
          <span className="flex items-center gap-1.5">
            <SourceBadge provider={r.provider} />
            <span className="font-mono text-xs text-muted-foreground">
              {r.sha ? r.sha.slice(0, 7) : "—"}
            </span>
          </span>
        </div>
      ),
    },
    {
      id: "status",
      label: t("status"),
      header: t("status"),
      cell: (r) => (
        <RunStatusBadge status={r.status} conclusion={r.conclusion} />
      ),
    },
    ...(showName
      ? [
          {
            id: "workflow",
            label: t("workflow"),
            header: t("workflow"),
            hideBelow: "sm" as const,
            className: "max-w-48 truncate",
            cell: (r: CiRun) =>
              r.provider === "github" && r.workflowId && r.repoFullName ? (
                <Link
                  href={workflowHref(login, r.repoFullName, r.workflowId)}
                  className="underline-offset-2 hover:underline"
                >
                  {r.name}
                </Link>
              ) : (
                r.name
              ),
          } satisfies Column<CiRun>,
        ]
      : []),
    {
      id: "trigger",
      label: t("trigger"),
      header: t("trigger"),
      hideBelow: "md",
      className: "max-w-64",
      cell: (r) => (
        <span className="flex min-w-0 flex-wrap gap-x-1.5 text-sm">
          <span className="max-w-40 truncate font-medium">
            {r.branch ?? "—"}
          </span>
          <span className="text-muted-foreground">
            {[r.event, r.actorLogin].filter(Boolean).join(" · ")}
          </span>
        </span>
      ),
    },
    {
      id: "duration",
      label: t("duration"),
      header: t("duration"),
      align: "right",
      cell: (r) => formatDuration(r.durationS),
    },
    {
      id: "created",
      label: t("created"),
      header: t("created"),
      align: "right",
      hideBelow: "md",
      cell: (r) => (
        <time
          dateTime={r.createdAt}
          title={format.dateTime(new Date(r.createdAt), {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          className="text-xs whitespace-nowrap text-muted-foreground"
        >
          {format.relativeTime(new Date(r.createdAt))}
        </time>
      ),
    },
    ...(actions
      ? [
          {
            id: "actions",
            label: t("actions"),
            header: t("actions"),
            hideBelow: "md" as const,
            cell: (r: CiRun) =>
              r.provider === "github" ? (
                <RunActions
                  installationId={actions.installationId}
                  compact
                  run={{
                    id: r.id,
                    repoFullName: r.repoFullName ?? "",
                    workflowName: r.name,
                    runNumber: r.number != null ? Number(r.number) : null,
                    runAttempt: r.attempt,
                    status: r.status,
                    conclusion: r.conclusion,
                    isPlaceholder: r.isPlaceholder,
                  }}
                />
              ) : null,
          } satisfies Column<CiRun>,
        ]
      : []),
  ];
  const shown = compact
    ? columns.filter((c) => c.id !== "trigger" && c.id !== "created")
    : columns;
  return (
    <DataTable
      caption={caption}
      columns={shown}
      rows={runs}
      rowKey={(r) => `${r.provider}:${r.id}`}
      empty={<EmptyState quiet message={t("empty")} />}
    />
  );
}

/**
 * The repository's Runs tab with Azure DevOps connected: GitHub runs and
 * Azure builds merged by time, the source badge on every row and the CI
 * facet; the filters of the GitHub list (branch, event, conclusion, actor)
 * apply to both where they can (Azure builds have no actor).
 */
export async function CiRunsSection({
  scope,
  installationId,
  repositoryId,
  login,
  base,
  sp,
  hidden,
  canOperate,
  title,
}: {
  scope: TenantScope;
  installationId: bigint;
  repositoryId?: bigint;
  login: string;
  base: string;
  sp: SearchParams;
  hidden: Record<string, string>;
  canOperate: boolean;
  title: string;
}) {
  const values = {
    branch: textFilter(param(sp, "branch")),
    event: textFilter(param(sp, "event")),
    conclusion: parseConclusion(param(sp, "conclusion")),
    actor: textFilter(param(sp, "actor")),
  };
  const ci = parseCiFacet(param(sp, "ci"));
  const before = decode(param(sp, "before"));
  const { runs, next } = await orNotFound(
    listCiRuns(scope, installationId, {
      provider: ci,
      ...(repositoryId !== undefined ? { repositoryId } : {}),
      ...values,
      ...(before ? { before } : {}),
      limit: PAGE,
    }),
  );
  const keep = { ...hidden, ...(ci !== "all" ? { ci } : {}) };
  const active = Object.values(values).some(Boolean);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">{title}</h2>
      <CiFacet base={base} sp={sp} />
      <RunFilters
        action={base}
        hidden={keep}
        values={values}
        clearHref={active ? withParams(base, {}, keep) : undefined}
      />
      <CiRunsTable
        login={login}
        runs={runs}
        caption={title}
        actions={
          canOperate ? { installationId: String(installationId) } : undefined
        }
      />
      {runs.length > 0 ? (
        <CursorFooter
          shown={runs.length}
          olderHref={
            next ? withParams(base, sp, { before: encode(next) }) : null
          }
          newestHref={
            before ? withParams(base, sp, { before: undefined }) : null
          }
        />
      ) : null}
    </section>
  );
}
