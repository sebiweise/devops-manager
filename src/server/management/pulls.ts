import "server-only";
import { randomUUID } from "node:crypto";
import { dependabotUpdateType, isPatchOrMinor } from "@/lib/dependabot-update";
import { BULK_MERGE_LIMIT } from "@/lib/management-view";
import {
  beginAction,
  defaultActionDeps,
  recordAndExecute,
  type ActionActor,
  type ActionDeps,
  type ActionResult,
  type ActionSession,
  type Done,
} from "@/server/authz/action";
import {
  findRepoTarget,
  findRepoTargets,
  type RepoTarget,
} from "@/server/data/management";
import { forgetPulls, readRepoPulls } from "@/server/data/pulls";
import { githubErrorInfo } from "@/server/github/errors";
import { mergePurposeFor } from "@/server/github/purposes";
import {
  getPull,
  listPullCommits,
  listPullFiles,
  mergePull,
  type GhPull,
  type GhPullCommit,
  type MergeMethod,
} from "@/server/github/rest";
import type { GitHubApi } from "@/server/ingest/github-client";

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
 *   `DevOps-Manager-Audit: <auditId>` (no app user's name or email goes into
 *   the repository), appended to the body GitHub would write by default:
 *   the PR title for a merge commit, the squashed commit messages and their
 *   co-authors for a squash. A rebase merge has no merge commit, so it gets
 *   no trailer; the audit row records `auditTrailer: false`.
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

const CO_AUTHOR = /^co-authored-by:\s*(.+)$/i;

/**
 * The commit message for a merge with the audit trailer, or null when the
 * method writes no merge commit message (rebase). The default body is kept:
 * the PR title for "merge"; for "squash" the body of a single commit, or the
 * list of commit messages, with the Co-authored-by trailers GitHub adds for
 * commit authors other than the PR's author.
 */
export function trailerMessage(
  method: MergeMethod,
  pull: { title?: string; user?: { login: string } | null },
  commits: readonly GhPullCommit[],
  trailer: string,
): string | null {
  if (method === "rebase") return null;
  if (method === "merge")
    return pull.title ? `${pull.title}\n\n${trailer}` : trailer;
  const coAuthors: string[] = [];
  const addCoAuthor = (line: string) => {
    if (!coAuthors.some((c) => c.toLowerCase() === line.toLowerCase()))
      coAuthors.push(line);
  };
  const bodies = commits.map((c) => {
    const kept: string[] = [];
    for (const line of c.commit.message.replace(/\r\n/g, "\n").split("\n")) {
      const m = line.trim().match(CO_AUTHOR);
      if (m) addCoAuthor(`Co-authored-by: ${m[1]!.trim()}`);
      else kept.push(line);
    }
    return kept.join("\n").trim();
  });
  for (const c of commits) {
    const { name, email } = c.commit.author ?? {};
    if (c.author?.login && c.author.login === pull.user?.login) continue;
    if (name && email) addCoAuthor(`Co-authored-by: ${name} <${email}>`);
  }
  const body =
    bodies.length === 1
      ? bodies[0]!.split("\n").slice(1).join("\n").trim()
      : bodies
          .filter((b) => b.length > 0)
          .map((b) => `* ${b}`)
          .join("\n\n");
  return [body, [...coAuthors, trailer].join("\n")]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

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

/** The merge call and the re-read of the result, shared by single and bulk merges. */
async function performMerge(
  api: GitHubApi,
  repo: RepoTarget,
  m: {
    number: number;
    sha: string;
    method: MergeMethod;
    pull: GhPull;
    commits: readonly GhPullCommit[];
    trailer: boolean;
    auditId: string;
    workflowsTouched: boolean;
  },
): Promise<Done<MergeData>> {
  const message = m.trailer
    ? trailerMessage(
        m.method,
        m.pull,
        m.commits,
        `${AUDIT_TRAILER}: ${m.auditId}`,
      )
    : null;
  const res = await mergePull(api, repo, m.number, {
    sha: m.sha,
    method: m.method,
    ...(message ? { commitMessage: message } : {}),
  });
  let after: GhPull | null = null;
  try {
    after = await getPull(api, repo, m.number);
  } catch {
    after = null;
  }
  return {
    data: {
      merged: after?.merged ?? true,
      mergeCommitSha: after?.merge_commit_sha ?? res.sha,
      workflowsTouched: m.workflowsTouched,
    },
    httpStatus: res.httpStatus,
    requestId: res.requestId,
  };
}

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

  const trailer = deps.mergeAuditTrailer && input.method !== "rebase";
  let pull: GhPull;
  let files: string[];
  let commits: GhPullCommit[] = [];
  try {
    const read = await session.api("read.pulls", [repo.id]);
    pull = await getPull(read, repo, input.number);
    files = await listPullFiles(read, repo, input.number);
    if (trailer && input.method === "squash")
      commits = await listPullCommits(read, repo, input.number);
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
        auditTrailer: trailer,
      },
    },
    purpose,
    [repo.id],
    (api, auditId) =>
      performMerge(api, repo, {
        number: input.number,
        sha: input.sha,
        method: input.method,
        pull,
        commits,
        trailer,
        auditId,
        workflowsTouched,
      }),
  );
  forgetPulls(input.installationId);
  return result;
}

// ---------- guarded Dependabot bulk merge ----------

export const MAX_BULK_MERGE = BULK_MERGE_LIMIT;

const isDependabot = (login: string | null | undefined) =>
  !!login && /^dependabot(\[bot\])?$/i.test(login);

export type BulkMergeItem = {
  repositoryId: bigint;
  number: number;
  /** The head SHA shown in the dialog. */
  sha: string;
};

export type BulkMergeInput = {
  installationId: bigint;
  items: BulkMergeItem[];
  /** Must equal the number of items. */
  typed: string;
  idempotencyKey: string;
};

export type BulkMergeRow = {
  repositoryId: string;
  fullName: string | null;
  number: number;
  /**
   * merged; skipped: not eligible at the re-check (reason); failed: the
   * merge or the re-check failed unexpectedly, which stops the batch;
   * not_attempted: after a stop.
   */
  status: "merged" | "skipped" | "failed" | "not_attempted";
  reason?: string;
  message?: string;
  method?: MergeMethod;
  updateType?: string;
  auditId?: string;
};

export type BulkMergeResult = {
  batchId: string;
  rows: BulkMergeRow[];
  merged: number;
  skipped: number;
  failed: number;
  notAttempted: number;
};

type Eligible = {
  pull: GhPull;
  commits: GhPullCommit[];
  method: MergeMethod;
  purpose: "act.merge" | "act.merge.workflows";
  updateType: string;
};

function defaultMethod(allowed: readonly MergeMethod[]): MergeMethod | null {
  for (const m of ["squash", "merge", "rebase"] as const)
    if (allowed.includes(m)) return m;
  return null;
}

/**
 * Re-reads one PR right before its merge and decides whether the bulk merge
 * may merge it: opened by Dependabot, open, not a draft, head still at the
 * SHA shown, mergeable with the merge state "clean" (no acknowledgement in
 * bulk), checks green, a patch or minor update, the token's permissions
 * granted and a merge method allowed. Throws on read errors.
 */
async function recheck(
  session: ActionSession,
  read: GitHubApi,
  repo: RepoTarget,
  item: BulkMergeItem,
): Promise<{ ok: true; eligible: Eligible } | { ok: false; reason: string }> {
  const pull = await getPull(read, repo, item.number);
  if (!isDependabot(pull.user?.login))
    return { ok: false, reason: "not_dependabot" };
  if (pull.merged) return { ok: false, reason: "already_merged" };
  if (pull.state !== "open") return { ok: false, reason: "not_open" };
  if (pull.draft) return { ok: false, reason: "draft" };
  if (pull.head.sha !== item.sha) return { ok: false, reason: "head_moved" };
  if (pull.mergeable !== true) return { ok: false, reason: "not_mergeable" };
  const state = (pull.mergeable_state ?? "unknown").toLowerCase();
  if (state === "blocked") return { ok: false, reason: "branch_protection" };
  if (state !== "clean") return { ok: false, reason: "not_clean" };
  const live = await readRepoPulls(read, repo);
  if (live.repo.status !== "ok") throw new Error("pull requests unreadable");
  const row = live.pulls.find((p) => p.number === item.number);
  if (row?.checks !== "SUCCESS")
    return { ok: false, reason: "checks_not_green" };
  const commits = await listPullCommits(read, repo, item.number);
  const updateType = dependabotUpdateType(
    pull.title ?? "",
    commits.map((c) => c.commit.message),
  );
  if (!updateType || !isPatchOrMinor(updateType))
    return { ok: false, reason: "not_patch_or_minor" };
  const purpose = mergePurposeFor(await listPullFiles(read, repo, item.number));
  if (session.missing(purpose))
    return { ok: false, reason: "workflows_not_granted" };
  const method = defaultMethod(live.repo.mergeMethods);
  if (!method) return { ok: false, reason: "no_method" };
  return {
    ok: true,
    eligible: {
      pull,
      commits,
      method,
      purpose: purpose as Eligible["purpose"],
      updateType,
    },
  };
}

/**
 * Guarded Dependabot bulk merge (design §8.2 #10), admin only: one
 * PR_BULK_MERGE parent row and one PR_MERGE child per merged PR (same
 * batch), merged one after another through the single-merge path. Each PR
 * is re-checked right before its merge; one that no longer qualifies is
 * skipped with its reason. The first unexpected error (a failed merge or
 * re-check) stops the batch, and the rest is reported as not attempted.
 * The typed confirmation is the number of PRs listed in the dialog.
 */
export async function bulkMergeDependabot(
  actor: ActionActor,
  input: BulkMergeInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult<BulkMergeResult>> {
  const seen = new Set<string>();
  const items = input.items.filter((i) => {
    const k = `${i.repositoryId}#${i.number}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (items.length === 0) return { status: "refused", reason: "unchanged" };
  if (items.length > MAX_BULK_MERGE)
    return { status: "refused", reason: "too_many_pulls" };
  const repos = await findRepoTargets(
    actor.scope,
    input.installationId,
    items.map((i) => i.repositoryId),
  );
  const byId = new Map(repos.map((r) => [r.id, r]));
  const batchId = randomUUID();
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: "PR_BULK_MERGE",
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: { type: "batch", id: batchId },
      confirmation: "TYPED",
      purpose: "act.merge",
      cost: items.length,
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (
    !session.confirm({
      kind: "TYPED",
      typed: input.typed,
      expected: String(items.length),
    })
  )
    return { status: "confirmation_mismatch" };

  const parent = await session.record({
    batchId,
    params: {
      items: items.map((i) => ({
        repositoryId: String(i.repositoryId),
        number: i.number,
        sha: i.sha,
      })),
      auditTrailer: deps.mergeAuditTrailer,
    },
  });
  if (!parent.created)
    return { status: "pending", auditId: parent.id, replayed: true };

  const rows: BulkMergeRow[] = [];
  let stopped = false;
  let read: GitHubApi | null = null;
  for (const item of items) {
    const repo = byId.get(item.repositoryId);
    const base = {
      repositoryId: String(item.repositoryId),
      fullName: repo?.fullName ?? null,
      number: item.number,
    };
    if (stopped) {
      rows.push({ ...base, status: "not_attempted" });
      continue;
    }
    if (!repo || !repo.selected || repo.archived) {
      rows.push({
        ...base,
        status: "skipped",
        reason: repo?.archived ? "archived" : "not_selected",
      });
      continue;
    }
    let check: Awaited<ReturnType<typeof recheck>>;
    try {
      read ??= await session.api(
        "read.pulls",
        repos.map((r) => r.id),
      );
      check = await recheck(session, read, repo, item);
    } catch (error) {
      const info = githubErrorInfo(error);
      rows.push({
        ...base,
        status: "failed",
        reason: info.status === 404 ? "pr_not_found" : "unreadable",
        message: info.message,
      });
      stopped = true;
      continue;
    }
    if (!check.ok) {
      rows.push({ ...base, status: "skipped", reason: check.reason });
      continue;
    }
    const { pull, commits, method, purpose, updateType } = check.eligible;
    const trailer = deps.mergeAuditTrailer && method !== "rebase";
    const workflowsTouched = purpose === "act.merge.workflows";
    const child = await session.record({
      action: "PR_MERGE",
      target: {
        type: "pr",
        id: `${repo.fullName}#${item.number}`,
        repositoryId: repo.id,
        repoFullName: repo.fullName,
      },
      batchId,
      idempotencyKey: `${input.idempotencyKey}:${repo.id}#${item.number}`,
      params: {
        number: item.number,
        method,
        sha: item.sha,
        workflowsTouched,
        mergeableState: "clean",
        acknowledgedNotClean: false,
        updateType,
        auditTrailer: trailer,
      },
    });
    const outcome = await session.execute(child.id, purpose, [repo.id], (api) =>
      performMerge(api, repo, {
        number: item.number,
        sha: item.sha,
        method,
        pull,
        commits,
        trailer,
        auditId: child.id,
        workflowsTouched,
      }),
    );
    if (outcome.status === "succeeded") {
      rows.push({
        ...base,
        status: "merged",
        method,
        updateType,
        auditId: child.id,
      });
    } else {
      rows.push({
        ...base,
        status: "failed",
        method,
        updateType,
        message: outcome.status === "failed" ? outcome.message : "",
        auditId: child.id,
      });
      stopped = true;
    }
  }

  const count = (s: BulkMergeRow["status"]) =>
    rows.filter((r) => r.status === s).length;
  const data: BulkMergeResult = {
    batchId,
    rows,
    merged: count("merged"),
    skipped: count("skipped"),
    failed: count("failed"),
    notAttempted: count("not_attempted"),
  };
  const message = `${data.failed} of ${rows.length} pull requests failed, ${data.notAttempted} not attempted`;
  await session.finish(
    parent.id,
    data.failed === 0
      ? { status: "SUCCEEDED" }
      : { status: "FAILED", error: message },
  );
  forgetPulls(input.installationId);
  session.revalidate();
  return data.failed === 0
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
