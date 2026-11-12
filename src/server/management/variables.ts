import "server-only";
import { randomUUID } from "node:crypto";
import { mapLimit } from "@/lib/concurrency";
import {
  beginAction,
  defaultActionDeps,
  recordAndExecute,
  type ActionActor,
  type ActionDeps,
  type ActionResult,
  type ActionSession,
  type Denial,
} from "@/server/authz/action";
import { hasRole } from "@/server/authz/roles";
import {
  batchIdOfAudit,
  findBatch,
  findBatchRevert,
  type BatchRecord,
} from "@/server/data/audit";
import {
  findInstallationAccount,
  findRepoTarget,
  findRepoTargets,
  getManagementState,
  listRepoTargets,
  type RepoTarget,
} from "@/server/data/management";
import { forgetVariables } from "@/server/data/variables";
import { githubErrorInfo } from "@/server/github/errors";
import { missingOf } from "@/server/github/purposes";
import {
  addOrgVariableRepo,
  deleteOrgVariable as ghDeleteOrgVariable,
  deleteRepoVariable as ghDeleteRepoVariable,
  getOrgVariable,
  getRepoVariable,
  listOrgVariableRepos,
  removeOrgVariableRepo,
  writeOrgVariable,
  writeRepoVariable,
  type OrgVisibility,
} from "@/server/github/rest";
import type { GitHubApi } from "@/server/ingest/github-client";
import { auditValue, revealAuditValue } from "./audit-values";
import {
  isValidVariableName,
  isValidVariableValue,
  planBulkSet,
  planRevert,
  type BatchWrite,
  type BulkRow,
  type RepoVariableState,
  type RevertRow,
} from "./variable-rules";

/**
 * Repository and organisation Actions variables (design §8.2 #5 to #8),
 * admin only. Every write is performed by the App with an `act.variables`
 * token narrowed to the target repos (`act.org_variables` for the org),
 * audited with `{before, after}` (sha256 and length only, plus a sealed copy,
 * when the installation redacts values).
 *
 * - Single set: GET the current value, PATCH it, or POST when it does not
 *   exist. Dialog with the diff; an `expectedBefore` that no longer matches
 *   is refused as a stale preview.
 * - Delete: TYPED variable name.
 * - Bulk set (presets such as LINUX_RUNNER): preview diff first, TYPED
 *   variable name, one parent VAR_BULK row with a batch id plus one child
 *   row per changed repo, concurrency 3, per-repo results.
 * - Revert batch: restores the recorded `before` values (deleting variables
 *   the batch created), skipping repos changed since; VAR_BULK_REVERT
 *   linked to the original batch. A batch is reverted at most once.
 */

const WRITE_CONCURRENCY = 3;
const READ_CONCURRENCY = 4;
const MAX_BULK_REPOS = 500;

const invalidName: Denial = { status: "refused", reason: "invalid_name" };
const invalidValue: Denial = { status: "refused", reason: "invalid_value" };

// ---------- single repository variable ----------

export type VariableChange = { before: string | null; after: string | null };

export type SetVariableInput = {
  installationId: bigint;
  repositoryId: bigint;
  name: string;
  value: string;
  /** The value the dialog showed (null = not set); omitted = no check. */
  expectedBefore?: string | null;
  confirmed: boolean;
  idempotencyKey: string;
};

const variableTarget = (repo: RepoTarget, name: string) => ({
  type: "variable",
  id: name,
  repositoryId: repo.id,
  repoFullName: repo.fullName,
});

async function readCurrent(
  session: ActionSession,
  repo: RepoTarget,
  name: string,
): Promise<{ ok: true; value: string | null } | { ok: false; result: Denial }> {
  try {
    const api = await session.api("read.variables", [repo.id]);
    return { ok: true, value: await getRepoVariable(api, repo, name) };
  } catch (error) {
    return {
      ok: false,
      result: {
        status: "refused",
        reason: "unreadable",
        detail: { httpStatus: githubErrorInfo(error).status },
      },
    };
  }
}

export async function setRepoVariable(
  actor: ActionActor,
  input: SetVariableInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult<VariableChange>> {
  const repo = await findRepoTarget(
    actor.scope,
    input.installationId,
    input.repositoryId,
  );
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: "VAR_UPDATE",
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: variableTarget(repo, input.name),
      confirmation: "DIALOG",
      purpose: "act.variables",
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (!isValidVariableName(input.name)) return invalidName;
  if (!isValidVariableValue(input.value)) return invalidValue;
  if (repo.archived) return { status: "refused", reason: "archived" };

  const current = await readCurrent(session, repo, input.name);
  if (!current.ok) return current.result;
  if (
    input.expectedBefore !== undefined &&
    input.expectedBefore !== current.value
  )
    return {
      status: "refused",
      reason: "stale_preview",
      detail: { current: current.value },
    };
  if (current.value === input.value)
    return { status: "refused", reason: "unchanged" };
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };

  const redact = session.installation.redactVariableValues;
  const id = session.installation.id;
  const result = await recordAndExecute(
    session,
    {
      action: current.value === null ? "VAR_CREATE" : "VAR_UPDATE",
      params: {
        name: input.name,
        before: auditValue(current.value, redact, id),
        after: auditValue(input.value, redact, id),
      },
    },
    "act.variables",
    [repo.id],
    async (api) => {
      const res = await writeRepoVariable(
        api,
        repo,
        input.name,
        input.value,
        current.value !== null,
      );
      return {
        data: {
          before: current.value,
          after: await getRepoVariable(api, repo, input.name),
        },
        ...res,
      };
    },
  );
  forgetVariables(id);
  return result;
}

export type DeleteVariableInput = {
  installationId: bigint;
  repositoryId: bigint;
  name: string;
  typed: string;
  idempotencyKey: string;
};

export async function deleteRepoVariable(
  actor: ActionActor,
  input: DeleteVariableInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult<VariableChange>> {
  const repo = await findRepoTarget(
    actor.scope,
    input.installationId,
    input.repositoryId,
  );
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: "VAR_DELETE",
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: variableTarget(repo, input.name),
      confirmation: "TYPED",
      purpose: "act.variables",
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (!isValidVariableName(input.name)) return invalidName;
  if (repo.archived) return { status: "refused", reason: "archived" };
  if (
    !session.confirm({
      kind: "TYPED",
      typed: input.typed,
      expected: input.name,
    })
  )
    return { status: "confirmation_mismatch" };
  const current = await readCurrent(session, repo, input.name);
  if (!current.ok) return current.result;
  if (current.value === null)
    return { status: "refused", reason: "variable_not_found" };

  const redact = session.installation.redactVariableValues;
  const id = session.installation.id;
  const result = await recordAndExecute(
    session,
    {
      params: {
        name: input.name,
        before: auditValue(current.value, redact, id),
        after: null,
      },
    },
    "act.variables",
    [repo.id],
    async (api) => ({
      data: { before: current.value, after: null },
      ...(await ghDeleteRepoVariable(api, repo, input.name)),
    }),
  );
  forgetVariables(id);
  return result;
}

// ---------- bulk set ----------

export type BulkPreview =
  { status: "ok"; name: string; value: string; rows: BulkRow[] } | Denial;

/** Read-only checks shared by the previews: admin, management on, permission granted. */
async function previewGate(
  actor: ActionActor,
  installationId: bigint,
): Promise<
  | { ok: true; permissions: Record<string, unknown> }
  | { ok: false; result: Denial }
> {
  const state = await getManagementState(actor.scope, installationId);
  if (!state.globalEnabled)
    return {
      ok: false,
      result: { status: "management_disabled", level: "global" },
    };
  if (!state.installationEnabled)
    return {
      ok: false,
      result: { status: "management_disabled", level: "installation" },
    };
  if (!hasRole(actor.scope.role, "ADMIN"))
    return { ok: false, result: { status: "forbidden" } };
  const inst = await findInstallationAccount(actor.scope, installationId);
  const missing = missingOf("act.variables", inst.permissions);
  if (missing)
    return { ok: false, result: { status: "permission_not_granted", missing } };
  return { ok: true, permissions: inst.permissions };
}

/** Current values of `name` in the target repos (undefined = unreadable). */
async function liveStates(
  api: GitHubApi | null,
  repos: readonly RepoTarget[],
  name: string,
  concurrency = READ_CONCURRENCY,
): Promise<RepoVariableState[]> {
  return mapLimit(repos, concurrency, async (repo) => {
    const base = {
      repositoryId: String(repo.id),
      fullName: repo.fullName,
      archived: repo.archived,
      selected: repo.selected,
    };
    if (!api || !repo.selected || repo.archived)
      return { ...base, current: undefined };
    try {
      return { ...base, current: await getRepoVariable(api, repo, name) };
    } catch {
      return { ...base, current: undefined };
    }
  });
}

function writable(repos: readonly RepoTarget[]) {
  return repos.filter((r) => r.selected && !r.archived);
}

export type BulkInput = {
  installationId: bigint;
  name: string;
  value: string;
  repositoryIds: bigint[];
};

/** The diff a bulk set would apply: repo, current -> new, unchanged and skipped repos marked. */
export async function previewBulkSet(
  actor: ActionActor,
  input: BulkInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<BulkPreview> {
  if (input.repositoryIds.length > MAX_BULK_REPOS)
    return { status: "refused", reason: "too_many_repositories" };
  const repos = await findRepoTargets(
    actor.scope,
    input.installationId,
    input.repositoryIds,
  );
  const gate = await previewGate(actor, input.installationId);
  if (!gate.ok) return gate.result;
  if (!isValidVariableName(input.name)) return invalidName;
  if (!isValidVariableValue(input.value)) return invalidValue;
  const targets = writable(repos);
  const api =
    targets.length > 0
      ? await deps.clients.installation(
          input.installationId,
          "read.variables",
          gate.permissions,
          targets.map((r) => r.id),
        )
      : null;
  const states = await liveStates(api, repos, input.name);
  return {
    status: "ok",
    name: input.name,
    value: input.value,
    rows: planBulkSet(states, input.value),
  };
}

export type BulkRowResult = {
  repositoryId: string;
  fullName: string;
  /** What was (or would have been) done. */
  change: BulkRow["change"] | RevertRow["change"];
  status: "succeeded" | "failed" | "skipped" | "unchanged";
  reason?: string;
  /** GitHub's message for a failed write. */
  message?: string;
  auditId?: string;
};

export type BulkResult = {
  batchId: string;
  rows: BulkRowResult[];
  succeeded: number;
  failed: number;
};

/** Rebuilds the result of a finished batch from its audit rows (idempotent replay). */
function resultFromBatch(batch: BatchRecord): BulkResult {
  const rows: BulkRowResult[] = batch.children.map((c) => ({
    repositoryId: c.repositoryId ?? "",
    fullName: c.repoFullName ?? "",
    change:
      c.action === "VAR_CREATE"
        ? "create"
        : c.action === "VAR_DELETE"
          ? "delete"
          : batch.parent.action === "VAR_BULK_REVERT"
            ? "restore"
            : "update",
    status:
      c.status === "SUCCEEDED"
        ? "succeeded"
        : c.status === "FAILED"
          ? "failed"
          : "skipped",
    ...(c.error ? { message: c.error } : {}),
    auditId: c.auditId,
  }));
  return {
    batchId: batch.parent.batchId,
    rows,
    succeeded: rows.filter((r) => r.status === "succeeded").length,
    failed: rows.filter((r) => r.status === "failed").length,
  };
}

async function replayBatch(
  actor: ActionActor,
  installationId: bigint,
  result: ActionResult<never>,
  auditId: string | undefined,
): Promise<ActionResult<BulkResult>> {
  if (!auditId || (result.status !== "succeeded" && result.status !== "failed"))
    return result;
  const batch = await findBatch(
    actor.scope,
    installationId,
    await batchIdOfAudit(actor.scope, installationId, auditId),
  );
  return { ...result, data: resultFromBatch(batch) };
}

type ChildPlan = {
  repo: RepoTarget;
  /** Decides the write from the value read right before it. */
  decide: (current: string | null) =>
    | {
        kind: "skip";
        change: BulkRowResult["change"];
        status: "unchanged" | "skipped";
        reason?: string;
      }
    | {
        kind: "write";
        action: "VAR_CREATE" | "VAR_UPDATE" | "VAR_DELETE";
        change: BulkRowResult["change"];
        after: string | null;
      };
};

/**
 * Runs the children of a recorded bulk parent: one `act.variables` token
 * narrowed to the writable repos, a fresh GET per repo, one audited write
 * per changed repo (concurrency 3), then the parent's final status.
 */
async function runBatch(
  session: ActionSession,
  parentId: string,
  batchId: string,
  name: string,
  plans: ChildPlan[],
  extraParams: Record<string, unknown> = {},
): Promise<ActionResult<BulkResult>> {
  const id = session.installation.id;
  const redact = session.installation.redactVariableValues;
  let api: GitHubApi;
  try {
    api = await session.api(
      "act.variables",
      plans.map((p) => p.repo.id),
    );
  } catch (error) {
    const info = githubErrorInfo(error);
    await session.finish(parentId, {
      status: "FAILED",
      httpStatus: info.status,
      githubRequestId: info.requestId,
      error: info.message,
    });
    return {
      status: "failed",
      auditId: parentId,
      replayed: false,
      httpStatus: info.status,
      message: info.message,
    };
  }

  const rows = await mapLimit(
    plans,
    WRITE_CONCURRENCY,
    async (plan): Promise<BulkRowResult> => {
      const base = {
        repositoryId: String(plan.repo.id),
        fullName: plan.repo.fullName,
      };
      let current: string | null;
      try {
        current = await getRepoVariable(api, plan.repo, name);
      } catch (error) {
        return {
          ...base,
          change: "skipped",
          status: "failed",
          reason: "unreadable",
          message: githubErrorInfo(error).message,
        };
      }
      const decision = plan.decide(current);
      if (decision.kind === "skip")
        return {
          ...base,
          change: decision.change,
          status: decision.status,
          ...(decision.reason ? { reason: decision.reason } : {}),
        };
      const child = await session.record({
        action: decision.action,
        target: {
          type: "variable",
          id: name,
          repositoryId: plan.repo.id,
          repoFullName: plan.repo.fullName,
        },
        batchId,
        idempotencyKey: `${session.spec.idempotencyKey}:${plan.repo.id}`,
        params: {
          name,
          before: auditValue(current, redact, id),
          after: auditValue(decision.after, redact, id),
          ...extraParams,
        },
      });
      const outcome = await session.perform(child.id, async () => ({
        data: null,
        ...(decision.after === null
          ? await ghDeleteRepoVariable(api, plan.repo, name)
          : await writeRepoVariable(
              api,
              plan.repo,
              name,
              decision.after,
              current !== null,
            )),
      }));
      return outcome.status === "succeeded"
        ? {
            ...base,
            change: decision.change,
            status: "succeeded",
            auditId: child.id,
          }
        : {
            ...base,
            change: decision.change,
            status: "failed",
            message: outcome.status === "failed" ? outcome.message : "",
            auditId: child.id,
          };
    },
  );

  const failed = rows.filter((r) => r.status === "failed").length;
  const succeeded = rows.filter((r) => r.status === "succeeded").length;
  await session.finish(
    parentId,
    failed === 0
      ? { status: "SUCCEEDED" }
      : {
          status: "FAILED",
          error: `${failed} of ${rows.length} repositories failed`,
        },
  );
  forgetVariables(id);
  session.revalidate();
  const data: BulkResult = { batchId, rows, succeeded, failed };
  return failed === 0
    ? { status: "succeeded", auditId: parentId, replayed: false, data }
    : {
        status: "failed",
        auditId: parentId,
        replayed: false,
        httpStatus: null,
        message: `${failed} of ${rows.length} repositories failed`,
        data,
      };
}

export type BulkSetInput = BulkInput & {
  typed: string;
  idempotencyKey: string;
};

export async function bulkSetVariable(
  actor: ActionActor,
  input: BulkSetInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult<BulkResult>> {
  if (input.repositoryIds.length > MAX_BULK_REPOS)
    return { status: "refused", reason: "too_many_repositories" };
  const repos = await findRepoTargets(
    actor.scope,
    input.installationId,
    input.repositoryIds,
  );
  const batchId = randomUUID();
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: "VAR_BULK",
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: { type: "batch", id: batchId },
      confirmation: "TYPED",
      purpose: "act.variables",
      cost: Math.max(1, writable(repos).length),
    },
    deps,
  );
  if (!begun.ok)
    return replayBatch(
      actor,
      input.installationId,
      begun.result,
      begun.replayOf,
    );
  const { session } = begun;
  if (!isValidVariableName(input.name)) return invalidName;
  if (!isValidVariableValue(input.value)) return invalidValue;
  if (
    !session.confirm({
      kind: "TYPED",
      typed: input.typed,
      expected: input.name,
    })
  )
    return { status: "confirmation_mismatch" };
  const targets = writable(repos);
  if (targets.length === 0)
    return { status: "refused", reason: "no_writable_repositories" };

  const id = session.installation.id;
  const parent = await session.record({
    batchId,
    params: {
      name: input.name,
      value: auditValue(
        input.value,
        session.installation.redactVariableValues,
        id,
      ),
      repositories: repos.map((r) => String(r.id)),
    },
  });
  if (!parent.created)
    return replayBatch(
      actor,
      input.installationId,
      { status: "pending", auditId: parent.id, replayed: true },
      parent.id,
    );

  const skipped: BulkRowResult[] = repos
    .filter((r) => !r.selected || r.archived)
    .map((r) => ({
      repositoryId: String(r.id),
      fullName: r.fullName,
      change: "skipped",
      status: "skipped",
      reason: r.selected ? "archived" : "not_selected",
    }));
  const result = await runBatch(
    session,
    parent.id,
    batchId,
    input.name,
    targets.map((repo) => ({
      repo,
      decide: (current) =>
        current === input.value
          ? { kind: "skip", change: "unchanged", status: "unchanged" }
          : {
              kind: "write",
              action: current === null ? "VAR_CREATE" : "VAR_UPDATE",
              change: current === null ? "create" : "update",
              after: input.value,
            },
    })),
  );
  if (
    (result.status === "succeeded" || result.status === "failed") &&
    result.data
  )
    result.data.rows.push(...skipped);
  return result;
}

// ---------- revert ----------

export type RevertPreview =
  | {
      status: "ok";
      batchId: string;
      name: string;
      rows: RevertRow[];
      /** The audit id of an earlier revert of this batch. */
      revertedBy: string | null;
    }
  | Denial;

type RevertBasis = {
  batch: BatchRecord;
  name: string;
  writes: BatchWrite[];
  repos: RepoTarget[];
};

async function revertBasis(
  actor: ActionActor,
  installationId: bigint,
  batchId: string,
): Promise<RevertBasis | Denial> {
  const batch = await findBatch(actor.scope, installationId, batchId);
  if (batch.parent.action !== "VAR_BULK")
    return { status: "refused", reason: "not_revertible" };
  const name = batch.parent.params.name;
  if (typeof name !== "string")
    return { status: "refused", reason: "not_revertible" };
  const writes: BatchWrite[] = [];
  try {
    for (const c of batch.children) {
      if (c.status !== "SUCCEEDED" || !c.repositoryId) continue;
      if (c.action !== "VAR_CREATE" && c.action !== "VAR_UPDATE") continue;
      writes.push({
        repositoryId: c.repositoryId,
        fullName: c.repoFullName ?? "",
        before: revealAuditValue(c.params.before, installationId),
        after: revealAuditValue(c.params.after, installationId),
      });
    }
  } catch {
    // A sealed value from before the last key rotation cannot be opened.
    return { status: "refused", reason: "values_unavailable" };
  }
  const repos = await findRepoTargets(
    actor.scope,
    installationId,
    writes.map((w) => BigInt(w.repositoryId)),
  );
  return { batch, name, writes, repos };
}

export async function previewRevert(
  actor: ActionActor,
  input: { installationId: bigint; batchId: string },
  deps: ActionDeps = defaultActionDeps(),
): Promise<RevertPreview> {
  const basis = await revertBasis(actor, input.installationId, input.batchId);
  if ("status" in basis) return basis;
  const gate = await previewGate(actor, input.installationId);
  if (!gate.ok) return gate.result;
  const targets = writable(basis.repos);
  const api =
    targets.length > 0
      ? await deps.clients.installation(
          input.installationId,
          "read.variables",
          gate.permissions,
          targets.map((r) => r.id),
        )
      : null;
  const states = await liveStates(api, basis.repos, basis.name);
  const revert = await findBatchRevert(input.installationId, input.batchId);
  return {
    status: "ok",
    batchId: input.batchId,
    name: basis.name,
    rows: planRevert(
      basis.writes,
      new Map(states.map((s) => [s.repositoryId, s])),
    ),
    revertedBy: revert?.auditId ?? null,
  };
}

export type RevertInput = {
  installationId: bigint;
  batchId: string;
  typed: string;
  idempotencyKey: string;
};

export async function revertBatch(
  actor: ActionActor,
  input: RevertInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult<BulkResult>> {
  const basis = await revertBasis(actor, input.installationId, input.batchId);
  if ("status" in basis) return basis;
  // Checked before the pipeline spends rate-limit tokens; a replay of the
  // revert itself (same key) still goes through and returns its result.
  const earlier = await findBatchRevert(input.installationId, input.batchId);
  if (earlier && earlier.idempotencyKey !== input.idempotencyKey)
    return { status: "refused", reason: "already_reverted" };
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: "VAR_BULK_REVERT",
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: { type: "batch", id: input.batchId },
      confirmation: "TYPED",
      purpose: "act.variables",
      cost: Math.max(1, basis.writes.length),
    },
    deps,
  );
  if (!begun.ok)
    return replayBatch(
      actor,
      input.installationId,
      begun.result,
      begun.replayOf,
    );
  const { session } = begun;
  if (await findBatchRevert(input.installationId, input.batchId))
    return { status: "refused", reason: "already_reverted" };
  if (
    !session.confirm({
      kind: "TYPED",
      typed: input.typed,
      expected: basis.name,
    })
  )
    return { status: "confirmation_mismatch" };

  const repoById = new Map(basis.repos.map((r) => [String(r.id), r]));
  const skipped: BulkRowResult[] = [];
  const plans: ChildPlan[] = [];
  for (const w of basis.writes) {
    const repo = repoById.get(w.repositoryId);
    if (!repo || !repo.selected || repo.archived) {
      skipped.push({
        repositoryId: w.repositoryId,
        fullName: w.fullName,
        change: "skipped",
        status: "skipped",
        reason: repo?.archived ? "archived" : "not_selected",
      });
      continue;
    }
    plans.push({
      repo,
      decide: (current) => {
        const [row] = planRevert(
          [w],
          new Map([
            [w.repositoryId, { archived: false, selected: true, current }],
          ]),
        );
        if (!row || row.change === "skipped" || row.change === "unchanged")
          return {
            kind: "skip",
            change: row?.change ?? "skipped",
            status: row?.change === "unchanged" ? "unchanged" : "skipped",
            ...(row?.reason ? { reason: row.reason } : {}),
          };
        return {
          kind: "write",
          action: row.change === "delete" ? "VAR_DELETE" : "VAR_UPDATE",
          change: row.change,
          after: row.target,
        };
      },
    });
  }
  if (plans.length === 0)
    return { status: "refused", reason: "nothing_to_revert" };

  const newBatchId = randomUUID();
  const parent = await session.record({
    batchId: newBatchId,
    params: { name: basis.name, revertOf: input.batchId },
  });
  if (!parent.created)
    return replayBatch(
      actor,
      input.installationId,
      { status: "pending", auditId: parent.id, replayed: true },
      parent.id,
    );
  const result = await runBatch(
    session,
    parent.id,
    newBatchId,
    basis.name,
    plans,
    { revertOf: input.batchId },
  );
  if (
    (result.status === "succeeded" || result.status === "failed") &&
    result.data
  )
    result.data.rows.push(...skipped);
  return result;
}

// ---------- organisation variables ----------

export type OrgVariableState = {
  value: string;
  visibility: OrgVisibility;
  selectedRepositoryIds?: string[];
} | null;

export type OrgVariableChange = {
  before: OrgVariableState;
  after: OrgVariableState;
};

export type SetOrgVariableInput = {
  installationId: bigint;
  name: string;
  value: string;
  visibility: OrgVisibility;
  /** Repos of this installation, for `selected` visibility. */
  selectedRepositoryIds?: bigint[];
  typed: string;
  idempotencyKey: string;
};

async function orgGate(actor: ActionActor, installationId: bigint) {
  const inst = await findInstallationAccount(actor.scope, installationId);
  return inst;
}

async function readOrgCurrent(
  session: ActionSession,
  org: string,
  name: string,
) {
  try {
    const api = await session.api("read.org_variables");
    const value = await getOrgVariable(api, org, name);
    // The full selection (all pages, including repos outside this
    // installation), so it can be kept and recorded in `before`.
    const selection =
      value?.visibility === "selected"
        ? await listOrgVariableRepos(api, org, name)
        : null;
    return { ok: true as const, value, selection };
  } catch (error) {
    return {
      ok: false as const,
      result: {
        status: "refused",
        reason: "unreadable",
        detail: { httpStatus: githubErrorInfo(error).status },
      } satisfies Denial,
    };
  }
}

type OrgSelectionPlan = {
  /** The whole selection for POST/PATCH; null keeps GitHub's selection. */
  replace: number[] | null;
  add: number[];
  remove: number[];
  /** The selection afterwards; null when the visibility is not "selected". */
  final: number[] | null;
};

/**
 * How to reach the requested selection. The editor only knows this
 * installation's repos, so a variable that stays "selected" is changed with
 * per-repo add/remove calls: repos outside the installation (or beyond what
 * the editor shows) keep their access, and an unchanged selection is not
 * sent at all. A new "selected" variable, or one switching to "selected",
 * gets the requested list.
 */
async function planOrgSelection(
  actor: ActionActor,
  installationId: bigint,
  visibility: OrgVisibility,
  requested: number[],
  current: number[] | null,
): Promise<OrgSelectionPlan> {
  if (visibility !== "selected")
    return { replace: null, add: [], remove: [], final: null };
  if (!current)
    return { replace: requested, add: [], remove: [], final: requested };
  const known = new Set(
    (await listRepoTargets(actor.scope, installationId)).map((r) =>
      Number(r.id),
    ),
  );
  const want = new Set(requested);
  const have = new Set(current);
  const add = requested.filter((r) => !have.has(r));
  const remove = current.filter((r) => known.has(r) && !want.has(r));
  const final = [...current.filter((r) => !remove.includes(r)), ...add];
  return { replace: null, add, remove, final };
}

export async function setOrgVariable(
  actor: ActionActor,
  input: SetOrgVariableInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult<OrgVariableChange>> {
  const inst = await orgGate(actor, input.installationId);
  const selected =
    input.visibility === "selected"
      ? await findRepoTargets(
          actor.scope,
          input.installationId,
          input.selectedRepositoryIds ?? [],
        )
      : [];
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: "ORG_VAR_UPDATE",
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: { type: "org_variable", id: input.name },
      confirmation: "TYPED",
      purpose: "act.org_variables",
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (inst.accountType !== "ORGANIZATION")
    return { status: "refused", reason: "not_organization" };
  if (!isValidVariableName(input.name)) return invalidName;
  if (!isValidVariableValue(input.value)) return invalidValue;
  if (
    !session.confirm({
      kind: "TYPED",
      typed: input.typed,
      expected: input.name,
    })
  )
    return { status: "confirmation_mismatch" };
  const current = await readOrgCurrent(session, inst.accountLogin, input.name);
  if (!current.ok) return current.result;

  const redact = session.installation.redactVariableValues;
  const id = session.installation.id;
  const plan = await planOrgSelection(
    actor,
    input.installationId,
    input.visibility,
    selected.map((r) => Number(r.id)),
    current.selection,
  );
  const before: OrgVariableState = current.value
    ? {
        value: current.value.value,
        visibility: current.value.visibility,
        ...(current.selection
          ? { selectedRepositoryIds: current.selection.map(String) }
          : {}),
      }
    : null;
  const after: OrgVariableState = {
    value: input.value,
    visibility: input.visibility,
    ...(plan.final ? { selectedRepositoryIds: plan.final.map(String) } : {}),
  };
  return recordAndExecute(
    session,
    {
      action: current.value ? "ORG_VAR_UPDATE" : "ORG_VAR_CREATE",
      params: {
        name: input.name,
        before: before && {
          ...before,
          value: auditValue(before.value, redact, id),
        },
        after: { ...after, value: auditValue(after.value, redact, id) },
      },
    },
    "act.org_variables",
    undefined,
    async (api) => {
      let res = await writeOrgVariable(
        api,
        inst.accountLogin,
        {
          name: input.name,
          value: input.value,
          visibility: input.visibility,
          ...(plan.replace ? { selectedRepositoryIds: plan.replace } : {}),
        },
        current.value !== null,
      );
      forgetVariables(id);
      // Selection changes one repo at a time, so repos outside this
      // installation keep their access.
      for (const repoId of plan.add)
        res = await addOrgVariableRepo(
          api,
          inst.accountLogin,
          input.name,
          repoId,
        );
      for (const repoId of plan.remove)
        res = await removeOrgVariableRepo(
          api,
          inst.accountLogin,
          input.name,
          repoId,
        );
      return { data: { before, after }, ...res };
    },
  );
}

export type DeleteOrgVariableInput = {
  installationId: bigint;
  name: string;
  typed: string;
  idempotencyKey: string;
};

export async function deleteOrgVariable(
  actor: ActionActor,
  input: DeleteOrgVariableInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult<OrgVariableChange>> {
  const inst = await orgGate(actor, input.installationId);
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: "ORG_VAR_DELETE",
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: { type: "org_variable", id: input.name },
      confirmation: "TYPED",
      purpose: "act.org_variables",
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (inst.accountType !== "ORGANIZATION")
    return { status: "refused", reason: "not_organization" };
  if (!isValidVariableName(input.name)) return invalidName;
  if (
    !session.confirm({
      kind: "TYPED",
      typed: input.typed,
      expected: input.name,
    })
  )
    return { status: "confirmation_mismatch" };
  const current = await readOrgCurrent(session, inst.accountLogin, input.name);
  if (!current.ok) return current.result;
  if (!current.value)
    return { status: "refused", reason: "variable_not_found" };

  const redact = session.installation.redactVariableValues;
  const id = session.installation.id;
  const before: OrgVariableState = {
    value: current.value.value,
    visibility: current.value.visibility,
    ...(current.selection
      ? { selectedRepositoryIds: current.selection.map(String) }
      : {}),
  };
  return recordAndExecute(
    session,
    {
      params: {
        name: input.name,
        before: { ...before, value: auditValue(before.value, redact, id) },
        after: null,
      },
    },
    "act.org_variables",
    undefined,
    async (api) => {
      const res = await ghDeleteOrgVariable(api, inst.accountLogin, input.name);
      forgetVariables(id);
      return { data: { before, after: null }, ...res };
    },
  );
}
