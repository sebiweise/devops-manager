import "server-only";
import {
  beginAction,
  defaultActionDeps,
  recordAndExecute,
  type ActionActor,
  type ActionDeps,
  type ActionResult,
} from "@/server/authz/action";
import { findRepoTarget } from "@/server/data/management";
import { forgetPulls } from "@/server/data/pulls";
import { githubErrorInfo } from "@/server/github/errors";
import { mergePurposeFor } from "@/server/github/purposes";
import {
  getPull,
  listPullFiles,
  mergePull,
  type GhPull,
  type MergeMethod,
} from "@/server/github/rest";

/**
 * Merge a pull request as the App (design §8.2 #9, D4), admin only.
 *
 * - The merge is pinned to the head SHA the admin saw (`sha`); GitHub
 *   answers 409 when the head moved, and that message is shown verbatim.
 * - Before merging, the PR is re-read with a `read.pulls` token: a closed,
 *   draft or conflicting PR is refused without a merge call, and so is the
 *   merge state "blocked" (branch protection is never overridden, even when
 *   the App is a bypass actor); the advisory states "unstable", "behind" and
 *   "has_hooks" need the extra acknowledgement.
 * - The changed files (`GET /pulls/{n}/files`) decide the token:
 *   `act.merge.workflows` (with `workflows: write`) only when a file under
 *   `.github/workflows/` changes, `act.merge` otherwise. Both are narrowed to
 *   the PR's repository and never cached.
 * - With MERGE_AUDIT_TRAILER on, the merge commit message gets
 *   `DevOps-Manager-Audit: <auditId>` (no user name or email goes into the
 *   repository).
 */

export const AUDIT_TRAILER = "DevOps-Manager-Audit";

/**
 * Advisory merge states: the merge may go ahead once the admin acknowledges
 * them. "blocked" (branch protection) and "dirty" (conflicts) are refused,
 * any other state than "clean" counts as unknown.
 */
export const ACKNOWLEDGEABLE_STATES: ReadonlySet<string> = new Set([
  "unstable",
  "behind",
  "has_hooks",
]);

export type MergeInput = {
  installationId: bigint;
  repositoryId: bigint;
  number: number;
  /** The head SHA shown in the dialog. */
  sha: string;
  method: MergeMethod;
  /** Required when GitHub's merge state is not "clean". */
  acknowledgeNotClean?: boolean;
  confirmed: boolean;
  idempotencyKey: string;
};

export type MergeData = {
  merged: boolean;
  mergeCommitSha: string | null;
  workflowsTouched: boolean;
};

export async function mergePullRequest(
  actor: ActionActor,
  input: MergeInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult<MergeData>> {
  const repo = await findRepoTarget(
    actor.scope,
    input.installationId,
    input.repositoryId,
  );
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: "PR_MERGE",
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: {
        type: "pr",
        id: `${repo.fullName}#${input.number}`,
        repositoryId: repo.id,
        repoFullName: repo.fullName,
      },
      confirmation: "DIALOG",
      purpose: "act.merge",
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (repo.archived) return { status: "refused", reason: "archived" };

  let pull: GhPull;
  let files: string[];
  try {
    const read = await session.api("read.pulls", [repo.id]);
    pull = await getPull(read, repo, input.number);
    files = await listPullFiles(read, repo, input.number);
  } catch (error) {
    const info = githubErrorInfo(error);
    if (info.status === 404)
      return { status: "refused", reason: "pr_not_found" };
    return {
      status: "refused",
      reason: "unreadable",
      detail: { httpStatus: info.status, message: info.message },
    };
  }
  if (pull.merged) return { status: "refused", reason: "already_merged" };
  if (pull.state !== "open") return { status: "refused", reason: "not_open" };
  if (pull.draft) return { status: "refused", reason: "draft" };
  if (pull.mergeable === false)
    return {
      status: "refused",
      reason: "not_mergeable",
      detail: { mergeableState: pull.mergeable_state ?? null },
    };
  if (pull.mergeable === null)
    return { status: "refused", reason: "mergeability_unknown" };
  const state = (pull.mergeable_state ?? "unknown").toLowerCase();
  // "blocked" means required reviews, checks or rules are not met. The App
  // may be a bypass actor, so GitHub could accept the merge: never override
  // branch protection from here.
  if (state === "blocked")
    return { status: "refused", reason: "branch_protection" };
  if (state === "dirty")
    return {
      status: "refused",
      reason: "not_mergeable",
      detail: { mergeableState: state },
    };
  if (state !== "clean" && !ACKNOWLEDGEABLE_STATES.has(state))
    return {
      status: "refused",
      reason: "mergeability_unknown",
      detail: { mergeableState: state },
    };
  if (state !== "clean" && input.acknowledgeNotClean !== true)
    return {
      status: "refused",
      reason: "needs_acknowledgement",
      detail: { mergeableState: state },
    };

  const purpose = mergePurposeFor(files);
  const workflowsTouched = purpose === "act.merge.workflows";
  const missing = session.missing(purpose);
  if (missing) return { status: "permission_not_granted", missing };
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };

  const result = await recordAndExecute(
    session,
    {
      params: {
        number: input.number,
        method: input.method,
        sha: input.sha,
        workflowsTouched,
        mergeableState: state,
        acknowledgedNotClean: state !== "clean",
      },
    },
    purpose,
    [repo.id],
    async (api, auditId) => {
      const res = await mergePull(api, repo, input.number, {
        sha: input.sha,
        method: input.method,
        ...(deps.mergeAuditTrailer
          ? { commitMessage: `${AUDIT_TRAILER}: ${auditId}` }
          : {}),
      });
      let after: GhPull | null = null;
      try {
        after = await getPull(api, repo, input.number);
      } catch {
        after = null;
      }
      return {
        data: {
          merged: after?.merged ?? true,
          mergeCommitSha: after?.merge_commit_sha ?? res.sha,
          workflowsTouched,
        },
        httpStatus: res.httpStatus,
        requestId: res.requestId,
      };
    },
  );
  forgetPulls(input.installationId);
  return result;
}
