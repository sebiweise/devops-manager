import "server-only";
import { Prisma } from "@/generated/prisma/client";
import {
  azureAsRunStatus,
  type CiFacet,
  type CiProvider,
} from "@/lib/azure-view";
import type { TenantScope } from "@/server/authz/scope";
import { db } from "@/server/db";
import { inScope, NotFoundError } from "./installations";

/**
 * The read-only union of GitHub Actions runs and Azure Pipelines builds
 * (design addendum M7 §6 "Union layer"): one `UNION ALL` over WorkflowRun
 * and AzureBuild, always filtered by `installationId`, never over ignored
 * repositories, and limited with `LIMIT`. It is the only place where a
 * query reads both providers; every other GitHub query is unchanged. The
 * runs list, the overview, the repository page and the pull requests use
 * it; GitHub rows keep linking to /runs/<id>, Azure rows to
 * /pipelines/runs/<buildId>.
 */

export type CiRun = {
  provider: CiProvider;
  /** GitHub run id or Azure build id, as a string. */
  id: string;
  repositoryId: string | null;
  repoFullName: string | null;
  /** Workflow or definition name. */
  name: string;
  /** GitHub workflow id (links to the workflow page). */
  workflowId: string | null;
  number: string | null;
  attempt: number;
  branch: string | null;
  sha: string | null;
  prNumber: number | null;
  event: string | null;
  actorLogin: string | null;
  /** GitHub's vocabulary (status and conclusion; Azure partial = PARTIAL). */
  status: string;
  conclusion: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationS: number | null;
  isPlaceholder: boolean;
};

export type CiRunFilter = {
  provider?: CiFacet;
  repositoryId?: bigint;
  branch?: string;
  event?: string;
  /** GitHub conclusion names (SUCCESS, FAILURE, …); Azure results map to them. */
  conclusion?: string;
  /** GitHub only: Azure builds have no actor and are left out when it is set. */
  actor?: string;
  /** Head SHAs (pull requests). */
  shas?: ReadonlyArray<string>;
  before?: { createdAt: string; key: string };
  limit?: number;
};

type Row = {
  provider: CiProvider;
  id: string;
  repositoryId: bigint | null;
  name: string;
  workflowId: bigint | null;
  number: string | null;
  attempt: number;
  branch: string | null;
  sha: string | null;
  prNumber: number | null;
  event: string | null;
  actorLogin: string | null;
  status: string;
  result: string | null;
  timedOut: boolean;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  durationS: number | null;
  isPlaceholder: boolean;
  sortKey: string;
};

const AZURE_RESULT: Record<string, string[]> = {
  SUCCESS: ["SUCCEEDED"],
  FAILURE: ["FAILED", "PARTIALLY_SUCCEEDED"],
  CANCELLED: ["CANCELED"],
};

/** Stable keyset of the merged list: newest first, then provider and id. */
export function ciSortKey(provider: CiProvider, id: string): string {
  return `${provider === "github" ? "g" : "a"}${id.padStart(20, "0")}`;
}

export async function listCiRuns(
  scope: TenantScope,
  installationId: bigint,
  f: CiRunFilter = {},
): Promise<{ runs: CiRun[]; next: { createdAt: string; key: string } | null }> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const inst = await db.installation.findFirst({
    where: { id: installationId, deletedAt: null, suspendedAt: null },
    select: { id: true },
  });
  if (!inst) throw new NotFoundError();
  if (f.repositoryId !== undefined) {
    const repo = await db.repository.findFirst({
      where: {
        id: f.repositoryId,
        installationId,
        removedAt: null,
        ignoredAt: null,
      },
      select: { id: true },
    });
    if (!repo) throw new NotFoundError();
  }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const provider = f.provider ?? "all";
  const shas = (f.shas ?? [])
    .map((s) => s.toLowerCase())
    .filter((s) => /^[0-9a-f]{7,64}$/.test(s));
  const before = f.before
    ? Prisma.sql`AND (u."createdAt", u."sortKey") < (${new Date(f.before.createdAt)}::timestamptz, ${f.before.key})`
    : Prisma.empty;
  const github =
    provider === "azure"
      ? null
      : Prisma.sql`
        SELECT 'github'::text AS provider, r."id"::text AS id, r."repositoryId", r."workflowName" AS name,
          r."workflowId", r."runNumber"::text AS number, r."runAttempt" AS attempt,
          r."headBranch" AS branch, r."headSha" AS sha, NULL::int AS "prNumber", r."event",
          r."actorLogin", r."status"::text AS status, r."conclusion"::text AS result, false AS "timedOut",
          r."createdAt", r."runStartedAt" AS "startedAt", r."completedAt", r."durationS", r."isPlaceholder",
          'g' || lpad(r."id"::text, 20, '0') AS "sortKey"
        FROM "WorkflowRun" r
        WHERE r."installationId" = ${installationId}
          AND NOT EXISTS (SELECT 1 FROM "Repository" x WHERE x."id" = r."repositoryId" AND x."ignoredAt" IS NOT NULL)
          ${f.repositoryId !== undefined ? Prisma.sql`AND r."repositoryId" = ${f.repositoryId}` : Prisma.empty}
          ${f.branch ? Prisma.sql`AND r."headBranch" = ${f.branch}` : Prisma.empty}
          ${f.event ? Prisma.sql`AND r."event" = ${f.event}` : Prisma.empty}
          ${f.conclusion ? Prisma.sql`AND r."conclusion"::text = ${f.conclusion}` : Prisma.empty}
          ${f.actor ? Prisma.sql`AND r."actorLogin" = ${f.actor}` : Prisma.empty}
          ${shas.length ? Prisma.sql`AND r."headSha" = ANY(${shas}::text[])` : Prisma.empty}`;
  const azureResults = f.conclusion
    ? (AZURE_RESULT[f.conclusion] ?? null)
    : null;
  const azure =
    provider === "github" ||
    f.actor ||
    (f.conclusion && !azureResults && f.conclusion !== "TIMED_OUT")
      ? null
      : Prisma.sql`
        SELECT 'azure'::text AS provider, b."id"::text AS id, b."repositoryId",
          COALESCE(d."name", '#' || b."definitionId"::text) AS name,
          NULL::bigint AS "workflowId", b."buildNumber" AS number, b."maxAttempt" AS attempt,
          b."headBranch" AS branch, b."headSha" AS sha, b."prNumber", b."reason" AS event,
          NULL::text AS "actorLogin", b."status"::text AS status, b."result"::text AS result, b."timedOut",
          b."queuedAt" AS "createdAt", b."startedAt", b."finishedAt" AS "completedAt", b."durationS",
          false AS "isPlaceholder", 'a' || lpad(b."id"::text, 20, '0') AS "sortKey"
        FROM "AzureBuild" b
        LEFT JOIN "AzurePipelineDefinition" d
          ON d."installationId" = b."installationId" AND d."projectId" = b."projectId" AND d."id" = b."definitionId"
        WHERE b."installationId" = ${installationId} AND b."repositoryId" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "Repository" x WHERE x."id" = b."repositoryId" AND x."ignoredAt" IS NOT NULL)
          ${f.repositoryId !== undefined ? Prisma.sql`AND b."repositoryId" = ${f.repositoryId}` : Prisma.empty}
          ${f.branch ? Prisma.sql`AND b."headBranch" = ${f.branch}` : Prisma.empty}
          ${f.event ? Prisma.sql`AND b."reason" = ${f.event}` : Prisma.empty}
          ${f.conclusion === "TIMED_OUT" ? Prisma.sql`AND b."timedOut"` : Prisma.empty}
          ${azureResults ? Prisma.sql`AND b."status" = 'COMPLETED' AND NOT b."timedOut" AND b."result"::text = ANY(${azureResults}::text[])` : Prisma.empty}
          ${shas.length ? Prisma.sql`AND b."headSha" = ANY(${shas}::text[])` : Prisma.empty}`;
  const parts = [github, azure].filter((p): p is Prisma.Sql => p !== null);
  if (parts.length === 0) return { runs: [], next: null };
  const rows = await db.$queryRaw<Row[]>`
    SELECT * FROM (${Prisma.join(parts, " UNION ALL ")}) u
    WHERE true ${before}
    ORDER BY u."createdAt" DESC, u."sortKey" DESC
    LIMIT ${limit + 1}`;
  const repoIds = [
    ...new Set(
      rows.map((r) => r.repositoryId).filter((x): x is bigint => x != null),
    ),
  ];
  const repos = new Map(
    (
      await db.repository.findMany({
        where: { installationId, id: { in: repoIds } },
        select: { id: true, fullName: true },
      })
    ).map((r) => [r.id, r.fullName]),
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    runs: page.map((r) => {
      const st =
        r.provider === "azure"
          ? azureAsRunStatus(r.status, r.result, r.timedOut)
          : { status: r.status, conclusion: r.result };
      return {
        provider: r.provider,
        id: r.id,
        repositoryId: r.repositoryId != null ? String(r.repositoryId) : null,
        repoFullName:
          r.repositoryId != null ? (repos.get(r.repositoryId) ?? null) : null,
        name: r.name,
        workflowId: r.workflowId != null ? String(r.workflowId) : null,
        number: r.number,
        attempt: r.attempt,
        branch: r.branch,
        sha: r.sha,
        prNumber: r.prNumber,
        event: r.event,
        actorLogin: r.actorLogin,
        status: st.status,
        conclusion: st.conclusion,
        createdAt: r.createdAt.toISOString(),
        startedAt: r.startedAt ? r.startedAt.toISOString() : null,
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
        durationS: r.durationS,
        isPlaceholder: r.isPlaceholder,
      };
    }),
    next:
      rows.length > limit && last
        ? { createdAt: last.createdAt.toISOString(), key: last.sortKey }
        : null,
  };
}

/** Whether the installation has an Azure DevOps connection (the union is shown only then). */
export async function hasAzurePipelines(
  scope: TenantScope,
  installationId: bigint,
): Promise<boolean> {
  if (!inScope(scope, installationId)) throw new NotFoundError();
  const c = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: { installationId: true },
  });
  return !!c;
}
