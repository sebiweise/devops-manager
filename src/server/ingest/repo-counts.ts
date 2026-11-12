import "server-only";
import { db } from "@/server/db";
import { missingOf } from "@/server/github/purposes";
import { activeRepoWhere } from "./active-repos";
import type { Deadline } from "./budget";
import type { GitHubClients } from "./github-client";
import { redactError } from "./webhook";

/**
 * Reconcile step k) cached open pull request and Dependabot alert counts
 * per repository (UI overhaul §4.4), for the repositories table. One GraphQL
 * request per 20 repositories and purpose (`read.pulls`, `read.dependabot`),
 * at most every 6 hours per installation, skipped when the App lacks the
 * permission (the columns then stay null and the table shows "—"). Ignored
 * and archived repositories are not refreshed. The live pull request and
 * Dependabot pages write the same columns when they read GitHub.
 */

export const COUNTS_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHUNK = 20;
const HIGH = new Set(["CRITICAL", "HIGH"]);

type Repo = { id: bigint; ownerLogin: string; name: string };

export type RepoCounts = {
  repositoryId: bigint;
  openPrCount?: number | null;
  openAlertCount?: number | null;
  openAlertHighCount?: number | null;
};

/** Writes counts of active repositories (ignored ones are left untouched). */
export async function storeRepoCounts(
  installationId: bigint,
  counts: ReadonlyArray<RepoCounts>,
  now: Date = new Date(),
): Promise<void> {
  for (const c of counts) {
    const data: Record<string, number | null | Date> = {
      countsRefreshedAt: now,
    };
    if (c.openPrCount !== undefined) data.openPrCount = c.openPrCount;
    if (c.openAlertCount !== undefined) data.openAlertCount = c.openAlertCount;
    if (c.openAlertHighCount !== undefined)
      data.openAlertHighCount = c.openAlertHighCount;
    await db.repository.updateMany({
      where: { id: c.repositoryId, installationId, ignoredAt: null },
      data,
    });
  }
}

function query(repos: Repo[], part: "pulls" | "alerts"): string {
  const vars = repos
    .map((_, i) => `$o${i}: String!, $n${i}: String!`)
    .join(", ");
  const field =
    part === "pulls"
      ? "pullRequests(states: OPEN) { totalCount }"
      : "vulnerabilityAlerts(states: OPEN, first: 100) { totalCount nodes { securityVulnerability { severity } } }";
  const body = repos
    .map(
      (_, i) => `r${i}: repository(owner: $o${i}, name: $n${i}) { ${field} }`,
    )
    .join("\n");
  return `query(${vars}) {\n${body}\n}`;
}

type GqlRepo = {
  pullRequests?: { totalCount: number };
  vulnerabilityAlerts?: {
    totalCount: number;
    nodes: Array<{ securityVulnerability?: { severity?: string } | null }>;
  };
} | null;

/**
 * Refreshes the counts of an installation when they are older than 6 hours.
 * Returns the number of repositories written.
 */
export async function refreshRepoCounts(
  inst: { id: bigint; permissions: Record<string, unknown> },
  clients: GitHubClients,
  deadline: Deadline,
  force = false,
): Promise<number> {
  const now = new Date(deadline.now());
  const due = await db.repository.findMany({
    where: {
      installationId: inst.id,
      ...activeRepoWhere,
      archived: false,
      ...(force
        ? {}
        : {
            OR: [
              { countsRefreshedAt: null },
              {
                countsRefreshedAt: {
                  lt: new Date(now.getTime() - COUNTS_INTERVAL_MS),
                },
              },
            ],
          }),
    },
    orderBy: [{ countsRefreshedAt: { sort: "asc", nulls: "first" } }],
    select: { id: true, ownerLogin: true, name: true },
    take: 500,
  });
  if (due.length === 0) return 0;
  const parts: Array<{
    part: "pulls" | "alerts";
    purpose: "read.pulls" | "read.dependabot";
  }> = [];
  if (!missingOf("read.pulls", inst.permissions))
    parts.push({ part: "pulls", purpose: "read.pulls" });
  if (!missingOf("read.dependabot", inst.permissions))
    parts.push({ part: "alerts", purpose: "read.dependabot" });
  if (parts.length === 0) return 0;

  const counts = new Map<bigint, RepoCounts>(
    due.map((r) => [r.id, { repositoryId: r.id }]),
  );
  for (const { part, purpose } of parts) {
    let api;
    try {
      api = await clients.installation(inst.id, purpose, inst.permissions);
    } catch {
      continue;
    }
    for (let i = 0; i < due.length; i += CHUNK) {
      if (deadline.expired(10_000)) break;
      const chunk = due.slice(i, i + CHUNK);
      const variables: Record<string, string> = {};
      chunk.forEach((r, j) => {
        variables[`o${j}`] = r.ownerLogin;
        variables[`n${j}`] = r.name;
      });
      let data: Record<string, GqlRepo> = {};
      try {
        const res = await api.request<{ data?: Record<string, GqlRepo> }>(
          "POST /graphql",
          { query: query(chunk, part), variables },
        );
        data = res.data.data ?? {};
      } catch (error) {
        console.warn(
          "repository counts not refreshed",
          redactError(error instanceof Error ? error.message : String(error)),
        );
        continue;
      }
      chunk.forEach((repo, j) => {
        const r = data[`r${j}`];
        const c = counts.get(repo.id)!;
        if (part === "pulls")
          c.openPrCount = r?.pullRequests?.totalCount ?? null;
        else {
          const alerts = r?.vulnerabilityAlerts;
          c.openAlertCount = alerts?.totalCount ?? null;
          c.openAlertHighCount = alerts
            ? alerts.nodes.filter((n) =>
                HIGH.has(n.securityVulnerability?.severity ?? ""),
              ).length
            : null;
        }
      });
    }
  }
  const written = [...counts.values()].filter(
    (c) => c.openPrCount !== undefined || c.openAlertCount !== undefined,
  );
  await storeRepoCounts(inst.id, written, now);
  return written.length;
}
