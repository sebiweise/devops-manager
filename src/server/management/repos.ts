import "server-only";
import { randomUUID } from "node:crypto";
import {
  beginAction,
  defaultActionDeps,
  type ActionActor,
  type ActionDeps,
  type ActionResult,
  type ActionSession,
} from "@/server/authz/action";
import { batchIdOfAudit, findBatch } from "@/server/data/audit";
import {
  applyRepoIgnore,
  applyRepoUnignore,
  findIgnoreTargets,
  type IgnoreTarget,
} from "@/server/data/repos";

/**
 * Ignore and un-ignore repositories (UI overhaul §3.2), admin only, local
 * (no GitHub call), so they work while the installation's management toggle
 * is off; the global kill switch MANAGEMENT_ENABLED=false blocks them like
 * every other setting.
 *
 * One call handles 1 to 500 repositories: a parent row (target "batch") with
 * the requested ids, plus one REPO_IGNORE / REPO_UNIGNORE row per changed
 * repository, all sharing a batch id (the VAR_BULK / PR_BULK_MERGE pattern),
 * with params `{before, after, fork}`. Repositories already in the requested
 * state are reported as unchanged and get no row; when nothing would change
 * the call is refused as "unchanged" without an audit row.
 *
 * Ignore stops loading data at once (sync state and dirty marks go with
 * it); reconcile step j purges the stored runs, jobs and stats. Un-ignore
 * resets the sync state, so the next reconcile imports the history again.
 */

export const MAX_IGNORE_REPOS = 500;

export type IgnoreInput = {
  installationId: bigint;
  repositoryIds: bigint[];
  confirmed: boolean;
  idempotencyKey: string;
};

export type IgnoreRow = {
  repositoryId: string;
  fullName: string;
  status: "succeeded" | "failed" | "unchanged";
  auditId?: string;
  message?: string;
};

export type IgnoreResult = {
  batchId: string;
  rows: IgnoreRow[];
  changed: number;
  unchanged: number;
  failed: number;
  /** Ignore only: stored data is deleted by the next reconcile. */
  purgeQueued: boolean;
};

type Mode = "ignore" | "unignore";

async function replayResult(
  actor: ActionActor,
  installationId: bigint,
  mode: Mode,
  result: ActionResult<never>,
  auditId: string | undefined,
): Promise<ActionResult<IgnoreResult>> {
  if (!auditId || (result.status !== "succeeded" && result.status !== "failed"))
    return result;
  const batch = await findBatch(
    actor.scope,
    installationId,
    await batchIdOfAudit(actor.scope, installationId, auditId),
  );
  const rows: IgnoreRow[] = batch.children.map((c) => ({
    repositoryId: c.repositoryId ?? "",
    fullName: c.repoFullName ?? "",
    status: c.status === "SUCCEEDED" ? "succeeded" : "failed",
    auditId: c.auditId,
    ...(c.error ? { message: c.error } : {}),
  }));
  const changed = rows.filter((r) => r.status === "succeeded").length;
  return {
    ...result,
    data: {
      batchId: batch.parent.batchId,
      rows,
      changed,
      unchanged: 0,
      failed: rows.length - changed,
      purgeQueued: mode === "ignore" && changed > 0,
    },
  };
}

async function runChildren(
  session: ActionSession,
  actor: ActionActor,
  mode: Mode,
  batchId: string,
  targets: IgnoreTarget[],
): Promise<IgnoreRow[]> {
  const rows: IgnoreRow[] = [];
  // Sequential: each child is one short transaction plus its audit row, and
  // the audit chain serialises per installation anyway.
  for (const repo of targets) {
    const ignored = repo.ignoredAt != null;
    const child = await session.record({
      action: mode === "ignore" ? "REPO_IGNORE" : "REPO_UNIGNORE",
      target: {
        type: "repository",
        id: String(repo.id),
        repositoryId: repo.id,
        repoFullName: repo.fullName,
      },
      batchId,
      idempotencyKey: `${session.spec.idempotencyKey}:${repo.id}`,
      params: { before: ignored, after: mode === "ignore", fork: repo.fork },
    });
    const outcome = await session.perform(child.id, async () => {
      const changed =
        mode === "ignore"
          ? await applyRepoIgnore(
              actor.scope,
              session.installation.id,
              repo.id,
              actor.user.id,
              session.deps.now(),
            )
          : await applyRepoUnignore(
              actor.scope,
              session.installation.id,
              repo.id,
            );
      // A concurrent ignore of the same repo: the other call's row records it.
      if (!changed) throw new Error("repository state changed concurrently");
      return { data: null };
    });
    rows.push({
      repositoryId: String(repo.id),
      fullName: repo.fullName,
      status: outcome.status === "succeeded" ? "succeeded" : "failed",
      auditId: child.id,
      ...(outcome.status === "failed" ? { message: outcome.message } : {}),
    });
  }
  return rows;
}

async function setIgnored(
  actor: ActionActor,
  input: IgnoreInput,
  mode: Mode,
  deps: ActionDeps,
): Promise<ActionResult<IgnoreResult>> {
  if (input.repositoryIds.length === 0)
    return { status: "refused", reason: "no_repositories" };
  if (input.repositoryIds.length > MAX_IGNORE_REPOS)
    return { status: "refused", reason: "too_many_repositories" };
  const repos = await findIgnoreTargets(
    actor.scope,
    input.installationId,
    input.repositoryIds,
  );
  const batchId = randomUUID();
  const action = mode === "ignore" ? "REPO_IGNORE" : "REPO_UNIGNORE";
  const targets = repos.filter((r) =>
    mode === "ignore" ? r.ignoredAt == null : r.ignoredAt != null,
  );
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action,
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: { type: "batch", id: batchId },
      confirmation: "DIALOG",
      requiresManagement: false,
      cost: Math.max(1, targets.length),
    },
    deps,
  );
  if (!begun.ok)
    return replayResult(
      actor,
      input.installationId,
      mode,
      begun.result,
      begun.replayOf,
    );
  const { session } = begun;
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };
  if (targets.length === 0) return { status: "refused", reason: "unchanged" };

  const parent = await session.record({
    batchId,
    params: {
      repositories: repos.map((r) => String(r.id)),
      changed: targets.length,
    },
  });
  if (!parent.created)
    return replayResult(
      actor,
      input.installationId,
      mode,
      { status: "pending", auditId: parent.id, replayed: true },
      parent.id,
    );

  const changedRows = await runChildren(session, actor, mode, batchId, targets);
  const unchangedRows: IgnoreRow[] = repos
    .filter((r) => !targets.includes(r))
    .map((r) => ({
      repositoryId: String(r.id),
      fullName: r.fullName,
      status: "unchanged",
    }));
  const failed = changedRows.filter((r) => r.status === "failed").length;
  const data: IgnoreResult = {
    batchId,
    rows: [...changedRows, ...unchangedRows],
    changed: changedRows.length - failed,
    unchanged: unchangedRows.length,
    failed,
    purgeQueued: mode === "ignore" && changedRows.length - failed > 0,
  };
  const message = `${failed} of ${changedRows.length} repositories failed`;
  await session.finish(
    parent.id,
    failed === 0
      ? { status: "SUCCEEDED" }
      : { status: "FAILED", error: message },
  );
  session.revalidate();
  return failed === 0
    ? { status: "succeeded", auditId: parent.id, replayed: false, data }
    : {
        status: "failed",
        auditId: parent.id,
        replayed: false,
        httpStatus: null,
        message,
        data,
      };
}

export async function ignoreRepositories(
  actor: ActionActor,
  input: IgnoreInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult<IgnoreResult>> {
  return setIgnored(actor, input, "ignore", deps);
}

export async function unignoreRepositories(
  actor: ActionActor,
  input: IgnoreInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult<IgnoreResult>> {
  return setIgnored(actor, input, "unignore", deps);
}
