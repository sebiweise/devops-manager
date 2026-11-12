import "server-only";
import {
  beginAction,
  defaultActionDeps,
  recordAndExecute,
  type ActionActor,
  type ActionDeps,
  type ActionResult,
} from "@/server/authz/action";
import { lastRunCancelAt } from "@/server/data/audit";
import { findRunTarget } from "@/server/data/management";
import {
  getRun,
  runOperation,
  type LiveRun,
  type RunOperation,
} from "@/server/github/rest";

/**
 * Run actions (design §8.2 #1 to #4), operator or admin: re-run, re-run
 * failed jobs, cancel and force cancel. Performed by the App with an
 * `act.runs` token (Actions: write) narrowed to the run's repository.
 *
 * - Re-run is refused once the run reached attempt 50 (GitHub's limit).
 * - Force cancel is offered only for a run that is still in progress more
 *   than 60 s after a successful cancel recorded here.
 * - After the call the run is re-read from GitHub; nothing is written to the
 *   DB optimistically (webhooks and reconcile fold the new state).
 */

export const MAX_RUN_ATTEMPT = 50;
export const FORCE_CANCEL_AFTER_MS = 60_000;

const ACTIONS = {
  rerun: "RUN_RERUN",
  rerun_failed: "RUN_RERUN_FAILED",
  cancel: "RUN_CANCEL",
  force_cancel: "RUN_FORCE_CANCEL",
} as const;

export type RunActionInput = {
  installationId: bigint;
  runId: bigint;
  operation: RunOperation;
  enableDebugLogging?: boolean;
  confirmed: boolean;
  idempotencyKey: string;
};

export async function performRunAction(
  actor: ActionActor,
  input: RunActionInput,
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult<LiveRun>> {
  const run = await findRunTarget(
    actor.scope,
    input.installationId,
    input.runId,
  );
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: ACTIONS[input.operation],
      role: "OPERATOR",
      idempotencyKey: input.idempotencyKey,
      target: {
        type: "run",
        id: String(run.runId),
        repositoryId: run.repositoryId,
        repoFullName: run.fullName,
      },
      confirmation: "DIALOG",
      purpose: "act.runs",
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;

  if (input.operation === "rerun" && run.runAttempt >= MAX_RUN_ATTEMPT)
    return {
      status: "refused",
      reason: "attempt_limit",
      detail: { runAttempt: run.runAttempt },
    };
  if (input.operation === "force_cancel") {
    const cancelledAt = await lastRunCancelAt(input.installationId, run.runId);
    if (!cancelledAt) return { status: "refused", reason: "cancel_first" };
    if (deps.now().getTime() - cancelledAt.getTime() < FORCE_CANCEL_AFTER_MS)
      return {
        status: "refused",
        reason: "force_cancel_too_early",
        detail: {
          retryAfterS: Math.ceil(
            (FORCE_CANCEL_AFTER_MS -
              (deps.now().getTime() - cancelledAt.getTime())) /
              1000,
          ),
        },
      };
  }
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };

  return recordAndExecute(
    session,
    {
      params: {
        workflowName: run.workflowName,
        runNumber: run.runNumber,
        runAttempt: run.runAttempt,
        ...(input.operation === "rerun" || input.operation === "rerun_failed"
          ? { enableDebugLogging: input.enableDebugLogging === true }
          : {}),
      },
    },
    "act.runs",
    [run.repositoryId],
    async (api) => {
      const res = await runOperation(
        api,
        run,
        run.runId,
        input.operation,
        input.enableDebugLogging === true,
      );
      const live = await getRun(api, run, run.runId);
      return {
        data: live ?? { status: null, conclusion: null, runAttempt: null },
        httpStatus: res.httpStatus,
        requestId: res.requestId,
      };
    },
  );
}
