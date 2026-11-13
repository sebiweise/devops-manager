import "server-only";
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
import { inScope, NotFoundError } from "@/server/data/installations";
import {
  findDeploymentActionTarget,
  findVercelToggleTarget,
  linkDeploymentAudit,
  rollbackCandidateIds,
  setVercelManagement,
  type DeploymentActionTarget,
} from "@/server/data/vercel";
import {
  markVercelRevoked,
  vercelCredentialFor,
} from "@/server/ingest/vercel-credential";
import {
  applyProjectAliasRead,
  upsertDeployments,
} from "@/server/ingest/vercel-reconcile";
import { scrubKnown } from "@/server/ingest/webhook";
import {
  createVercelClient,
  vercelDeploymentUrl,
  VercelError,
  type VercelProjectInfo,
  type VercelReadApi,
} from "@/server/vercel/client";
import { buildLogExcerpt, type LogExcerpt } from "@/server/vercel/log-excerpt";

/**
 * Vercel management actions (design addendum §8, M6), through the one
 * management pipeline with `provider: "vercel"`:
 *
 * | action           | role     | confirmation                         |
 * | ---------------- | -------- | ------------------------------------ |
 * | VERCEL_REDEPLOY  | OPERATOR | DIALOG (preview), TYPED (production) |
 * | VERCEL_CANCEL    | OPERATOR | DIALOG; queued or building only      |
 * | VERCEL_PROMOTE   | OPERATOR | TYPED project name; READY production |
 * | VERCEL_ROLLBACK  | OPERATOR | TYPED project name; candidates only  |
 * | VERCEL_MANAGEMENT_TOGGLE | ADMIN | TYPED team slug              |
 *
 * Every Vercel action needs the global kill switch, the installation's
 * management toggle and the connection's own toggle (off by default); any
 * closed gate answers `unavailable` with a DENIED row. Params hold ids and
 * flags only; the audit row records Vercel's status, message and
 * `x-vercel-id`; the acting identity is the token (`vercel:token:<hint>`).
 * After the call the deployment or project is re-read from Vercel and
 * stored; nothing is guessed locally. A redeploy carries the audit id in
 * `meta.devopsManagerAudit`, so a deployment created by a request whose
 * outcome is unknown is linked to it later (reconcile v7).
 *
 * The build log excerpt is a live read for operators and admins: fetched,
 * scrubbed and returned, never stored or logged.
 */

export type VercelOperation = "redeploy" | "cancel" | "promote" | "rollback";

const ACTIONS = {
  redeploy: "VERCEL_REDEPLOY",
  cancel: "VERCEL_CANCEL",
  promote: "VERCEL_PROMOTE",
  rollback: "VERCEL_ROLLBACK",
} as const;

const CANCELABLE = new Set(["QUEUED", "INITIALIZING", "BUILDING"]);
const REDEPLOYABLE = new Set(["READY", "ERROR", "CANCELED"]);
/** Re-reads of the project while Vercel's alias job is still running. */
const ALIAS_POLLS = 3;
const ALIAS_POLL_MS = 1_000;

export type VercelActionDeps = ActionDeps & {
  /** Waits between alias job re-reads (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
};

export function defaultVercelActionDeps(
  overrides: Partial<VercelActionDeps> = {},
): VercelActionDeps {
  return { ...defaultActionDeps(), ...overrides };
}

export type DeploymentActionInput = {
  installationId: bigint;
  deploymentId: string;
  operation: VercelOperation;
  /** Redeploy: build the branch's latest commit instead of the same one. */
  withLatestCommit?: boolean;
  confirmed: boolean;
  /** TYPED actions: the project name. */
  typed?: string;
  idempotencyKey: string;
};

export type DeploymentActionData = {
  /** The deployment as Vercel reports it after the call (redeploy: the new one). */
  deploymentId: string | null;
  state: string | null;
  /** Promote and rollback: what serves production now. */
  liveDeploymentId?: string | null;
  aliasStatus?: string | null;
};

/** Production-affecting operations need the project name typed. */
export function typedConfirmation(
  operation: VercelOperation,
  target: string,
): boolean {
  return (
    operation === "promote" ||
    operation === "rollback" ||
    (operation === "redeploy" && target === "production")
  );
}

function refused(reason: string): ActionResult<never> {
  return { status: "refused", reason };
}

/** Precondition of each operation against the stored state. */
async function precheck(
  t: DeploymentActionTarget,
  operation: VercelOperation,
  installationId: bigint,
): Promise<ActionResult<never> | null> {
  switch (operation) {
    case "redeploy":
      return REDEPLOYABLE.has(t.state) ? null : refused("not_redeployable");
    case "cancel":
      return CANCELABLE.has(t.state) ? null : refused("not_cancelable");
    case "promote":
      if (t.target !== "production" || t.state !== "READY")
        return refused("not_promotable");
      if (t.liveProdDeploymentId === t.id && !t.autoAssignPausedAt)
        return refused("already_live");
      return null;
    case "rollback": {
      const ids = await rollbackCandidateIds(
        installationId,
        t.projectId,
        t.plan,
      );
      return ids.includes(t.id) ? null : refused("not_rollback_candidate");
    }
  }
}

/** Re-reads the project until Vercel's alias job is final (max 3 reads). */
async function readProjectAfterAlias(
  read: VercelReadApi,
  projectId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<VercelProjectInfo> {
  let project = await read.getProject(projectId);
  for (let i = 1; i < ALIAS_POLLS; i++) {
    const status = project.aliasRequest?.status;
    if (status !== "pending" && status !== "in-progress") break;
    await sleep(ALIAS_POLL_MS);
    project = await read.getProject(projectId);
  }
  return project;
}

export async function performVercelDeploymentAction(
  actor: ActionActor,
  input: DeploymentActionInput,
  deps: VercelActionDeps = defaultVercelActionDeps(),
): Promise<ActionResult<DeploymentActionData>> {
  // Resolve first: a deployment of another installation answers 404.
  const t = await findDeploymentActionTarget(
    actor.scope,
    input.installationId,
    input.deploymentId,
  );
  const typed = typedConfirmation(input.operation, t.target);
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: ACTIONS[input.operation],
      role: "OPERATOR",
      idempotencyKey: input.idempotencyKey,
      target: {
        type: "vercel_deployment",
        id: t.id,
        repositoryId: t.repositoryId,
        repoFullName: t.repoFullName,
      },
      confirmation: typed ? "TYPED" : "DIALOG",
      provider: "vercel",
      actingAs: t.actingAs,
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;

  const denied = await precheck(t, input.operation, input.installationId);
  if (denied) return denied;
  const confirmed = typed
    ? session.confirm({
        kind: "TYPED",
        typed: input.typed ?? "",
        expected: t.projectName,
      })
    : session.confirm({ kind: "DIALOG", confirmed: input.confirmed });
  if (!confirmed) return { status: "confirmation_mismatch" };

  const row = await session.record({
    params: {
      projectId: t.projectId,
      deploymentId: t.id,
      target: t.target,
      ...(input.operation === "redeploy"
        ? { withLatestCommit: input.withLatestCommit === true }
        : {}),
    },
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };

  const outcome = await session.executeVercel(row.id, (api) =>
    run(session, api, t, input, row.id, deps),
  );
  session.revalidate();
  return outcome;
}

async function run(
  session: ActionSession,
  api: Parameters<Parameters<ActionSession["executeVercel"]>[1]>[0],
  t: DeploymentActionTarget,
  input: DeploymentActionInput,
  auditId: string,
  deps: VercelActionDeps,
): Promise<Done<DeploymentActionData>> {
  const installationId = session.installation.id;
  const now = deps.now();
  const timezone = t.timezone;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  switch (input.operation) {
    case "redeploy": {
      const res = await api.write.redeploy({
        deploymentId: t.id,
        projectName: t.projectName,
        target: t.target === "production" ? "production" : null,
        withLatestCommit: input.withLatestCommit === true,
        auditId,
      });
      const id = res.deployment?.id ?? null;
      // Re-read the new deployment; the create response is the fallback.
      const fresh = id
        ? ((await api.read.getDeployment(id).catch(() => null)) ??
          res.deployment)
        : null;
      if (fresh) {
        await upsertDeployments(installationId, timezone, [fresh], now);
        await linkDeploymentAudit(
          session.actor.scope,
          installationId,
          fresh.id,
          auditId,
        );
      }
      return {
        data: { deploymentId: fresh?.id ?? id, state: fresh?.state ?? null },
        httpStatus: res.status,
        requestId: res.requestId,
      };
    }
    case "cancel": {
      const res = await api.write.cancel(t.id);
      const fresh =
        (await api.read.getDeployment(t.id).catch(() => null)) ??
        res.deployment;
      if (fresh)
        await upsertDeployments(installationId, timezone, [fresh], now);
      return {
        data: { deploymentId: t.id, state: fresh?.state ?? null },
        httpStatus: res.status,
        requestId: res.requestId,
      };
    }
    case "promote":
    case "rollback": {
      if (input.operation === "rollback") {
        // Re-read the target right before the call: it must still be ready.
        const target = await api.read.getDeployment(t.id);
        if (!target || target.state !== "READY")
          throw new VercelError(
            409,
            "not_rollback_candidate",
            "The deployment is no longer ready",
            null,
            `/v13/deployments/${t.id}`,
          );
      }
      const res =
        input.operation === "promote"
          ? await api.write.promote(t.projectId, t.id)
          : await api.write.rollback(t.projectId, t.id);
      const project = await readProjectAfterAlias(api.read, t.projectId, sleep);
      await applyProjectAliasRead(
        installationId,
        project,
        input.operation,
        deps.now(),
      );
      return {
        data: {
          deploymentId: t.id,
          state: "READY",
          liveDeploymentId: project.liveProductionId,
          aliasStatus: project.aliasRequest?.status ?? null,
        },
        httpStatus: res.status,
        requestId: res.requestId,
      };
    }
  }
}

/** VERCEL_MANAGEMENT_TOGGLE: admin, TYPED team slug, works while management is off. */
export async function setVercelManagementEnabled(
  actor: ActionActor,
  input: {
    installationId: bigint;
    enabled: boolean;
    typed: string;
    idempotencyKey: string;
  },
  deps: ActionDeps = defaultActionDeps(),
): Promise<ActionResult<{ enabled: boolean }>> {
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: "VERCEL_MANAGEMENT_TOGGLE",
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: { type: "vercel_team", id: String(input.installationId) },
      confirmation: "TYPED",
      requiresManagement: false,
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  const conn = await findVercelToggleTarget(actor.scope, input.installationId);
  if (!conn) return refused("not_connected");
  if (
    !session.confirm({
      kind: "TYPED",
      typed: input.typed,
      expected: conn.teamSlug,
    })
  )
    return { status: "confirmation_mismatch" };
  if (conn.managementEnabled === input.enabled) return refused("unchanged");
  const row = await session.record({
    params: {
      teamSlug: conn.teamSlug,
      before: conn.managementEnabled,
      after: input.enabled,
    },
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };
  const outcome = await session.perform(row.id, async () => {
    await setVercelManagement(actor.scope, input.installationId, input.enabled);
    return { data: { enabled: input.enabled } };
  });
  session.revalidate();
  return outcome;
}

export type BuildLogResult =
  | { status: "ok"; excerpt: LogExcerpt; vercelUrl: string }
  | { status: "forbidden" }
  | { status: "unauthorized" }
  | { status: "unavailable" }
  | { status: "rate_limited"; retryAfterS: number }
  | { status: "failed"; httpStatus: number | null; message: string };

/**
 * The build log excerpt of one deployment (design addendum D8): operators
 * and admins only (role re-resolved live), one rate-limit token, fetched
 * live, scrubbed of the token and token patterns, never stored or logged.
 * Viewers get "forbidden" and use the link to Vercel instead.
 */
export async function getBuildLogExcerpt(
  actor: ActionActor,
  input: { installationId: bigint; deploymentId: string },
  deps: Pick<ActionDeps, "now" | "vercelFetch"> = defaultActionDeps(),
): Promise<BuildLogResult> {
  if (!inScope(actor.scope, input.installationId)) throw new NotFoundError();
  const t = await findDeploymentActionTarget(
    actor.scope,
    input.installationId,
    input.deploymentId,
  );
  const role = await currentRole(actor.user.id);
  if (!role) return { status: "unauthorized" };
  if (!hasRole(role, "OPERATOR")) return { status: "forbidden" };
  const rate = await consumeActionTokens(actor.user.id, 1, deps.now());
  if (!rate.ok)
    return { status: "rate_limited", retryAfterS: rate.retryAfterS };
  const cred = await vercelCredentialFor(input.installationId);
  if (cred.kind !== "token") return { status: "unavailable" };
  try {
    const lines = await createVercelClient({
      token: cred.token,
      teamId: cred.teamId,
      fetch: deps.vercelFetch,
    }).getBuildLog(t.id);
    return {
      status: "ok",
      excerpt: buildLogExcerpt(lines, [cred.token]),
      vercelUrl: vercelDeploymentUrl(t.teamSlug, t.projectName, t.id),
    };
  } catch (error) {
    if (error instanceof VercelError && error.revoked)
      await markVercelRevoked(
        input.installationId,
        `${error.status ?? ""} ${error.message}`.trim(),
        deps.now(),
        cred.token,
      );
    return {
      status: "failed",
      httpStatus: error instanceof VercelError ? error.status : null,
      message: scrubKnown(
        error instanceof Error ? error.message : "unknown",
        [cred.token],
        200,
      ),
    };
  }
}
