import { CursorFooter } from "@/components/data/pagination";
import { orNotFound } from "@/lib/account-page";
import {
  decodeCursor,
  encodeCursor,
  param,
  parseConclusion,
  textFilter,
  withParams,
  type SearchParams,
} from "@/lib/insights-view";
import type { TenantScope } from "@/server/authz/scope";
import { listRuns } from "@/server/data/insights";
import { RunFilters } from "./run-filters";
import { RunsTable } from "./runs-table";

/** Newest runs per page of the run lists. */
const PAGE = 50;

/**
 * The run list with its filters and cursor footer (UI overhaul §2.7), the
 * same on the repository's Runs tab and the workflow page: branch, event,
 * conclusion and actor as a GET form, the 50 newest runs, then "Older
 * runs" by cursor.
 */
export async function RunsSection({
  scope,
  installationId,
  repositoryId,
  workflowId,
  login,
  base,
  sp,
  hidden,
  canOperate,
  title,
  showWorkflow = true,
}: {
  scope: TenantScope;
  installationId: bigint;
  repositoryId: bigint;
  workflowId?: bigint;
  login: string;
  /** The page URL the filters and cursor links go to. */
  base: string;
  sp: SearchParams;
  /** Params the filter form keeps (e.g. `tab=runs`). */
  hidden: Record<string, string>;
  canOperate: boolean;
  title: string;
  showWorkflow?: boolean;
}) {
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
      ...(workflowId !== undefined ? { workflowId } : {}),
      ...values,
      ...(before ? { before } : {}),
      limit: PAGE,
    }),
  );
  const active = Object.values(values).some(Boolean);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">{title}</h2>
      <RunFilters
        action={base}
        hidden={hidden}
        values={values}
        clearHref={
          active
            ? withParams(base, {}, hidden as Record<string, string>)
            : undefined
        }
      />
      <RunsTable
        accountLogin={login}
        runs={runs}
        caption={title}
        showWorkflow={showWorkflow}
        actions={
          canOperate ? { installationId: String(installationId) } : undefined
        }
      />
      {runs.length > 0 ? (
        <CursorFooter
          shown={runs.length}
          olderHref={
            next ? withParams(base, sp, { before: encodeCursor(next) }) : null
          }
          newestHref={
            before ? withParams(base, sp, { before: undefined }) : null
          }
        />
      ) : null}
    </section>
  );
}
