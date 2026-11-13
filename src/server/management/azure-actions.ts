import "server-only";
import { runWarning } from "@/lib/azure-usage";
import {
  beginAction,
  defaultActionDeps,
  type ActionActor,
  type ActionDeps,
  type ActionResult,
  type ActionSession,
  type Done,
} from "@/server/authz/action";
import { consumeActionTokens } from "@/server/authz/rate-limit";
import { hasRole } from "@/server/authz/roles";
import { currentRole } from "@/server/authz/scope";
import {
  AzureError,
  azureBuildUrl,
  createAzureClient,
} from "@/server/azure/client";
import {
  buildAzureLogExcerpt,
  type AzureLogExcerpt,
} from "@/server/azure/log-excerpt";
import { auditTagOf } from "@/server/azure/map";
import { refNameOf } from "@/server/azure/write";
import {
  findAzureBuildTarget,
  findAzureConnection,
  findAzureDefinitionTarget,
  getAzureActionState,
  knownBranch,
  linkAzureBuildAudit,
  markAzureBuildDirty,
  probeDefinition,
  setAzureManagement,
  setAzureScope,
  type AzureBuildTarget,
} from "@/server/data/azure";
import { inScope, NotFoundError } from "@/server/data/installations";
import { azureCredentialFor } from "@/server/ingest/azure-credential";
import {
  noteAzureFailure,
  upsertBuilds,
} from "@/server/ingest/azure-reconcile";
import { scrubKnown } from "@/server/ingest/webhook";
import { env } from "@/env";

/**
 * Azure Pipelines actions (design addendum M7b §7), through the one
 * management pipeline with `provider: "azure"`:
 *
 * | action                | role     | confirmation | precondition (re-read first)                        |
 * | ADO_QUEUE_RUN         | OPERATOR | DIALOG       | the definition is linked to an active repo; the branch is known |
 * | ADO_CANCEL            | OPERATOR | DIALOG       | not started, postponed or in progress               |
 * | ADO_RETRY             | OPERATOR | DIALOG       | completed and failed, partially succeeded or canceled |
 * | ADO_STAGE_RETRY       | OPERATOR | DIALOG       | the stage failed or was canceled (identifier from the stored timeline) |
 * | ADO_MANAGEMENT_TOGGLE | ADMIN    | TYPED org    | turning it on runs the execute probe (previewRun)   |
 *
 * Every Azure action needs MANAGEMENT_ENABLED, AZURE_MANAGEMENT_ENABLED,
 * the installation's toggle and the connection's own toggle (off by
 * default), a healthy connection with rate headroom and the execute scope;
 * any closed gate answers `unavailable` with a DENIED row. Params hold ids
 * only; the acting identity is the credential (`azure:pat:<hint>`,
 * `azure:sp:<hint>`, `azure:env-token`). After the call the build (and its
 * timeline) is re-read and stored. A queue tags the new build with
 * `dm-audit-<auditId>`, so a build created by a request whose outcome is
 * unknown is linked to the row later (exact by tag, else "probable").
 *
 * Quota: queue and retry warn when the definition's p90 exceeds the
 * minutes left (or comes within 10 minutes of the job time limit); with
 * `blockWhenQuotaExhausted` the minutes warning refuses the action.
 */

export type AzureActionDeps = ActionDeps;

export function defaultAzureActionDeps(
  overrides: Partial<ActionDeps> = {},
): ActionDeps {
  return { ...defaultActionDeps(), ...overrides };
}

function refused(reason: string): ActionResult<never> {
  return { status: "refused", reason };
}

export type BuildActionData = {
  buildId: number | null;
  status: string | null;
  result: string | null;
};

/**
 * Re-reads a build after an action and stores it; its timeline is marked
 * dirty, so the next pass (or the page's poll) reads the jobs first.
 */
async function reread(
  session: ActionSession,
  api: Parameters<Parameters<ActionSession["executeAzure"]>[1]>[0],
  t: { projectId: string; timezone: string },
  buildId: number,
  deps: ActionDeps,
): Promise<{ status: string | null; result: string | null }> {
  const installationId = session.installation.id;
  try {
    const r = await api.read.listBuilds(t.projectId, {
      buildIds: [buildId],
      top: 1,
    });
    await upsertBuilds(
      installationId,
      t.timezone,
      r.builds,
      t.projectId,
      deps.now(),
    );
    await markAzureBuildDirty(session.actor.scope, installationId, buildId);
    const b = r.builds[0];
    return { status: b?.status ?? null, result: b?.result ?? null };
  } catch {
    // The call itself succeeded; the next pass reads the build.
    return { status: null, result: null };
  }
}

// ---------- queue ----------

export async function queueAzureRun(
  actor: ActionActor,
  input: {
    installationId: bigint;
    projectId: string;
    definitionId: number;
    branch?: string | null;
    confirmed: boolean;
    idempotencyKey: string;
  },
  deps: ActionDeps = defaultAzureActionDeps(),
): Promise<ActionResult<BuildActionData>> {
  const t = await findAzureDefinitionTarget(
    actor.scope,
    input.installationId,
    input.projectId,
    input.definitionId,
    deps.now(),
  );
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: "ADO_QUEUE_RUN",
      role: "OPERATOR",
      idempotencyKey: input.idempotencyKey,
      target: {
        type: "azure_definition",
        id: `${t.projectId}:${t.id}`,
        repositoryId: t.repositoryId,
        repoFullName: t.repoFullName,
      },
      confirmation: "DIALOG",
      provider: "azure",
      actingAs: t.actingAs,
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };
  if (t.repositoryId == null) return refused("definition_unlinked");
  const branch = (input.branch?.trim() || t.defaultBranch) ?? "";
  let refName: string;
  try {
    refName = refNameOf(branch);
  } catch {
    return refused("branch_unknown");
  }
  if (
    !(await knownBranch(
      actor.scope,
      input.installationId,
      t.repositoryId,
      branch,
    ))
  )
    return refused("branch_unknown");
  const quota = await quotaBlock(
    actor,
    input.installationId,
    t.p90Minutes,
    deps,
  );
  if (quota) return quota;
  const row = await session.record({
    params: { projectId: t.projectId, definitionId: t.id, refName },
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };
  const outcome = await session.executeAzure(row.id, async (api) => {
    const res = await api.write.queueRun(t.projectId, t.id, refName);
    let state = {
      status: null as string | null,
      result: null as string | null,
    };
    if (res.buildId != null) {
      // Exact link for an unknown outcome later: the audit tag (verify: tag writes).
      await api.write
        .addTag(t.projectId, res.buildId, auditTagOf(row.id))
        .catch(() => undefined);
      state = await reread(session, api, t, res.buildId, deps);
      await linkAzureBuildAudit(
        actor.scope,
        input.installationId,
        res.buildId,
        row.id,
      );
    }
    return {
      data: {
        buildId: res.buildId,
        status: state.status,
        result: state.result,
      },
      httpStatus: res.status,
      requestId: res.activityId,
    } satisfies Done<BuildActionData>;
  });
  session.revalidate();
  return outcome;
}

/** The quota block of queue and retry (blockWhenQuotaExhausted). */
async function quotaBlock(
  actor: ActionActor,
  installationId: bigint,
  p90Minutes: number | null,
  deps: ActionDeps,
): Promise<ActionResult<never> | null> {
  const state = await getAzureActionState(
    actor.scope,
    installationId,
    deps.managementEnabled,
    deps.azureManagementEnabled === true,
    deps.now(),
  );
  if (!state?.blockWhenQuotaExhausted) return null;
  const w = runWarning({
    minutesLeft: state.minutesLeft,
    p90Minutes,
    maxJobMinutes: state.maxJobMinutes,
  });
  return w.quota ? refused("quota_exhausted") : null;
}

// ---------- cancel, retry, stage retry ----------

export type BuildOperation = "cancel" | "retry" | "retryStage";

const ACTIONS = {
  cancel: "ADO_CANCEL",
  retry: "ADO_RETRY",
  retryStage: "ADO_STAGE_RETRY",
} as const;

const CANCELABLE = new Set(["NOT_STARTED", "POSTPONED", "IN_PROGRESS"]);
const RETRYABLE = new Set(["FAILED", "PARTIALLY_SUCCEEDED", "CANCELED"]);

function precheck(
  t: AzureBuildTarget,
  op: BuildOperation,
  stage: string | null,
): ActionResult<never> | null {
  switch (op) {
    case "cancel":
      return CANCELABLE.has(t.status) ? null : refused("not_cancelable");
    case "retry":
      return t.status === "COMPLETED" && RETRYABLE.has(t.result)
        ? null
        : refused("not_retryable");
    case "retryStage": {
      if (!stage) return refused("invalid_stage");
      const s = t.stages.find((x) => x.identifier === stage);
      if (!s) return refused("invalid_stage");
      return t.status === "COMPLETED" &&
        s.state === "completed" &&
        (s.result === "FAILED" || s.result === "CANCELED")
        ? null
        : refused("stage_not_retryable");
    }
  }
}

export async function performAzureBuildAction(
  actor: ActionActor,
  input: {
    installationId: bigint;
    buildId: number;
    operation: BuildOperation;
    /** retryStage: the stage identifier, checked against the stored timeline. */
    stage?: string | null;
    confirmed: boolean;
    idempotencyKey: string;
  },
  deps: ActionDeps = defaultAzureActionDeps(),
): Promise<ActionResult<BuildActionData>> {
  // Resolve first: a build of another installation answers 404.
  const t = await findAzureBuildTarget(
    actor.scope,
    input.installationId,
    input.buildId,
  );
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: ACTIONS[input.operation],
      role: "OPERATOR",
      idempotencyKey: input.idempotencyKey,
      target: {
        type: "azure_build",
        id: String(t.id),
        repositoryId: t.repositoryId,
        repoFullName: t.repoFullName,
      },
      confirmation: "DIALOG",
      provider: "azure",
      actingAs: t.actingAs,
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };
  // The stage identifier comes from the stored timeline, never from the input as such.
  const stage =
    input.operation === "retryStage"
      ? (t.stages.find((s) => s.identifier === input.stage)?.identifier ?? null)
      : null;
  const denied = precheck(t, input.operation, stage);
  if (denied) return denied;
  if (input.operation === "retry") {
    const def = await findAzureDefinitionTarget(
      actor.scope,
      input.installationId,
      t.projectId,
      t.definitionId,
      deps.now(),
    ).catch(() => null);
    const quota = await quotaBlock(
      actor,
      input.installationId,
      def?.p90Minutes ?? null,
      deps,
    );
    if (quota) return quota;
  }
  const row = await session.record({
    params: {
      projectId: t.projectId,
      definitionId: t.definitionId,
      buildId: t.id,
      ...(stage ? { stage } : {}),
    },
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };
  const outcome = await session.executeAzure(row.id, async (api) => {
    const res =
      input.operation === "cancel"
        ? await api.write.cancel(t.projectId, t.id)
        : input.operation === "retry"
          ? await api.write.retry(t.projectId, t.id)
          : await api.write.retryStage(t.projectId, t.id, stage!);
    const state = await reread(session, api, t, t.id, deps);
    return {
      data: { buildId: t.id, status: state.status, result: state.result },
      httpStatus: res.status,
      requestId: res.activityId,
    } satisfies Done<BuildActionData>;
  });
  session.revalidate();
  return outcome;
}

// ---------- the toggle ----------

/**
 * ADO_MANAGEMENT_TOGGLE: admin, TYPED organisation name, works while the
 * installation's management is off. Turning it on first runs the execute
 * probe (previewRun on one linked definition: expands the YAML, starts
 * nothing); if it fails the toggle stays off and the scope shows missing.
 */
export async function setAzureManagementEnabled(
  actor: ActionActor,
  input: {
    installationId: bigint;
    enabled: boolean;
    typed: string;
    idempotencyKey: string;
  },
  deps: ActionDeps = defaultAzureActionDeps(),
): Promise<ActionResult<{ enabled: boolean }>> {
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: "ADO_MANAGEMENT_TOGGLE",
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: { type: "azure_org", id: String(input.installationId) },
      confirmation: "TYPED",
      requiresManagement: false,
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  const conn = await findAzureConnection(actor.scope, input.installationId);
  if (!conn) return refused("not_connected");
  if (
    !session.confirm({
      kind: "TYPED",
      typed: input.typed,
      expected: conn.orgName,
    })
  )
    return { status: "confirmation_mismatch" };
  if (conn.managementEnabled === input.enabled) return refused("unchanged");
  const probe = input.enabled
    ? await probeDefinition(actor.scope, input.installationId)
    : null;
  if (input.enabled && !probe) return refused("no_linked_definition");
  const row = await session.record({
    params: {
      before: conn.managementEnabled,
      after: input.enabled,
      ...(probe
        ? { probeDefinitionId: probe.id, probeProjectId: probe.projectId }
        : {}),
    },
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };
  if (!input.enabled) {
    const outcome = await session.perform(row.id, async () => {
      await setAzureManagement(actor.scope, input.installationId, false);
      return { data: { enabled: false } };
    });
    session.revalidate();
    return outcome;
  }
  const outcome = await session.executeAzure(row.id, async (api) => {
    try {
      const res = await api.write.previewRun(
        probe!.projectId,
        probe!.id,
        probe!.defaultBranch,
      );
      await setAzureScope(actor.scope, input.installationId, "execute", "ok");
      await setAzureManagement(actor.scope, input.installationId, true);
      return {
        data: { enabled: true },
        httpStatus: res.status,
        requestId: res.activityId,
      };
    } catch (error) {
      if (
        error instanceof AzureError &&
        (error.code === "forbidden" || error.code === "bad_request")
      )
        await setAzureScope(
          actor.scope,
          input.installationId,
          "execute",
          "missing",
        );
      throw error instanceof AzureError
        ? new AzureError(
            error.status,
            error.code,
            `execute_probe_failed: ${error.message}`,
            error.activityId,
            error.path,
          )
        : error;
    }
  });
  session.revalidate();
  return outcome;
}

// ---------- the log excerpt ----------

export type AzureLogResult =
  | { status: "ok"; excerpt: AzureLogExcerpt; azureUrl: string }
  | { status: "forbidden" }
  | { status: "unauthorized" }
  | { status: "unavailable" }
  | { status: "not_found" }
  | { status: "rate_limited"; retryAfterS: number }
  | { status: "failed"; httpStatus: number | null; message: string };

/**
 * The job log excerpt (design addendum M7 §6 "Run detail"): operators and
 * admins only (role re-resolved live), one rate-limit token, read live,
 * scrubbed of the credential, the organisation and project names and the
 * token patterns, capped at 200 lines and 64 KB, never stored or logged.
 */
export async function getAzureLogExcerpt(
  actor: ActionActor,
  input: {
    installationId: bigint;
    buildId: number;
    recordId: string;
    attempt: number;
  },
  deps: Pick<ActionDeps, "now" | "azureFetch"> = defaultActionDeps(),
): Promise<AzureLogResult> {
  if (!inScope(actor.scope, input.installationId)) throw new NotFoundError();
  const t = await findAzureBuildTarget(
    actor.scope,
    input.installationId,
    input.buildId,
  );
  const role = await currentRole(actor.user.id);
  if (!role) return { status: "unauthorized" };
  if (!hasRole(role, "OPERATOR")) return { status: "forbidden" };
  const log = t.logs.find(
    (l) =>
      l.recordId === input.recordId.toLowerCase() &&
      l.attempt === input.attempt,
  );
  if (!log) return { status: "not_found" };
  const rate = await consumeActionTokens(actor.user.id, 1, deps.now());
  if (!rate.ok)
    return { status: "rate_limited", retryAfterS: rate.retryAfterS };
  let secrets: string[] = [t.orgName];
  try {
    const cred = await azureCredentialFor(input.installationId, {
      fetch: deps.azureFetch,
    });
    if (cred.kind !== "token") return { status: "unavailable" };
    secrets = [...cred.secrets, cred.org, t.projectId, t.definitionName];
    const raw = await createAzureClient({
      org: cred.org,
      auth: cred.auth,
      fetch: deps.azureFetch,
    }).getLog(t.projectId, t.id, log.logId);
    return {
      status: "ok",
      excerpt: buildAzureLogExcerpt(raw, secrets),
      azureUrl: azureBuildUrl(cred.org, t.projectId, t.id),
    };
  } catch (error) {
    await noteAzureFailure(input.installationId, error, deps.now(), secrets);
    return {
      status: "failed",
      httpStatus: error instanceof AzureError ? error.status : null,
      message: scrubKnown(
        error instanceof Error ? error.message : "unknown",
        secrets,
        200,
      ),
    };
  }
}

/** Whether Azure actions are on at the env level (UI hint). */
export function azureManagementGlobal(): boolean {
  return env.MANAGEMENT_ENABLED && env.AZURE_MANAGEMENT_ENABLED;
}
