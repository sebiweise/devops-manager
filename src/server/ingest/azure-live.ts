import "server-only";
import { LRUCache } from "lru-cache";
import { createAzureClient, toDate, type Fetch } from "@/server/azure/client";
import { db } from "@/server/db";
import { azureCredentialFor } from "./azure-credential";
import { noteAzureFailure } from "./azure-reconcile";

/**
 * Live tasks of an Azure Pipelines run for the run page (design addendum M7
 * §6 "Run detail"): the Task records of the current timeline, read live and
 * cached in memory for 15 s per build; never stored. Only the task's
 * display name, state, result and times are kept; issues and logs are not.
 */

export type LiveTask = {
  jobRecordId: string;
  name: string;
  state: string;
  result: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

const cache = new LRUCache<string, LiveTask[]>({ max: 500, ttl: 15_000 });

export async function liveTasks(
  installationId: bigint,
  buildId: number,
  opts: { fetch?: Fetch } = {},
): Promise<LiveTask[] | null> {
  const key = `${installationId}:${buildId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const build = await db.azureBuild.findFirst({
    where: { installationId, id: buildId },
    select: { projectId: true },
  });
  const conn = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: { revokedAt: true, pausedUntil: true, orgName: true },
  });
  if (
    !build ||
    !conn ||
    conn.revokedAt ||
    (conn.pausedUntil && conn.pausedUntil > new Date())
  )
    return null;
  let secrets: string[] = [conn.orgName];
  try {
    const cred = await azureCredentialFor(installationId, {
      fetch: opts.fetch,
    });
    if (cred.kind !== "token") return null;
    secrets = [...cred.secrets, conn.orgName];
    const t = await createAzureClient({
      org: cred.org,
      auth: cred.auth,
      fetch: opts.fetch,
      maxRequests: 1,
    }).getTimeline(build.projectId, buildId);
    const tasks: LiveTask[] = (t?.records ?? [])
      .filter((r) => r.type === "Task" && r.parentId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .slice(0, 500)
      .map((r) => ({
        jobRecordId: r.parentId!.toLowerCase(),
        name: (r.name ?? "").slice(0, 200),
        state: r.state ?? "pending",
        result: r.result ?? null,
        startedAt: toDate(r.startTime)?.toISOString() ?? null,
        finishedAt: toDate(r.finishTime)?.toISOString() ?? null,
      }));
    cache.set(key, tasks);
    return tasks;
  } catch (error) {
    await noteAzureFailure(installationId, error, new Date(), secrets);
    return null;
  }
}

/** Tests only. */
export function clearLiveTasks(): void {
  cache.clear();
}
