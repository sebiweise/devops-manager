import "server-only";
import {
  beginAction,
  defaultActionDeps,
  type ActionActor,
  type ActionDeps,
  type ActionResult,
} from "@/server/authz/action";
import {
  createVercelConnection,
  deleteVercelConnection,
  findLinkableRepository,
  findVercelConnection,
  findVercelProject,
  rotateVercelConnection,
  setVercelProjectLink,
  teamConnectedElsewhere,
} from "@/server/data/vercel";
import {
  checkVercelToken,
  isTeamId,
  type TokenCheckError,
} from "@/server/ingest/vercel-connect";
import { encryptVercelToken } from "@/server/ingest/vercel-credential";
import type { Fetch } from "@/server/vercel/client";

/**
 * Connect, rotate and disconnect the Vercel team of an installation and the
 * manual project link (design addendum §5.1, §8.2), admin only, through the
 * management pipeline (idempotency, rate limit, DENIED rows, audit chain of
 * the installation). They change app data only, so they work while the
 * installation's management toggle is off (`requiresManagement: false`);
 * the global kill switch still applies.
 *
 * The token is validated with GETs before anything is stored (see
 * vercel-connect.ts), stored encrypted, and never written to the audit
 * params, errors or results: only its last 4 characters.
 */

export type VercelDeps = ActionDeps & {
  fetch?: Fetch;
  /** Schedules the first sync (`after()` in a request). */
  schedule?: (installationId: bigint) => void;
};

export type ConnectResult = ActionResult<{
  teamSlug: string;
  teamName: string;
  scope: "team" | "full" | null;
}>;

const TOKEN = /^[A-Za-z0-9_-]{8,256}$/;

type ConnectInput = {
  installationId: bigint;
  token: string;
  teamId?: string | null;
  confirmed: boolean;
  idempotencyKey: string;
};

function invalid(
  reason:
    | TokenCheckError
    | "invalid_input"
    | "team_changed"
    | "already_connected"
    | "already_connected_elsewhere"
    | "not_connected"
    | "env_managed",
) {
  return { status: "refused" as const, reason };
}

/** Connect (VERCEL_CONNECT) or rotate (VERCEL_TOKEN_ROTATE) the token. */
async function storeToken(
  mode: "connect" | "rotate",
  actor: ActionActor,
  input: ConnectInput,
  deps: VercelDeps,
): Promise<ConnectResult> {
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: mode === "connect" ? "VERCEL_CONNECT" : "VERCEL_TOKEN_ROTATE",
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: { type: "vercel_team", id: String(input.installationId) },
      confirmation: "DIALOG",
      requiresManagement: false,
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };

  const token = input.token.trim();
  const teamId = input.teamId?.trim() || null;
  if (!TOKEN.test(token) || (teamId !== null && !isTeamId(teamId)))
    return invalid("invalid_input");

  const existing = await findVercelConnection(
    actor.scope,
    input.installationId,
  );
  if (mode === "connect" && existing) return invalid("already_connected");
  if (mode === "rotate") {
    if (!existing) return invalid("not_connected");
    if (existing.tokenSource === "ENV") return invalid("env_managed");
  }

  const hint = token.slice(-4);
  const check = await checkVercelToken(
    token,
    teamId ?? (mode === "rotate" ? existing!.teamId : null),
    deps.fetch,
    deps.now(),
  );
  // Every validated attempt leaves a row; a refused token never reaches the DB.
  const row = await session.record({
    params: check.ok
      ? {
          teamId: check.team.id,
          teamSlug: check.team.slug,
          tokenHint: hint,
          scope: check.scope ?? "unknown",
        }
      : { tokenHint: hint, ...(teamId ? { teamId } : {}) },
    actingAs: `vercel:token:${hint}`,
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };

  const fail = async (reason: string) => {
    await session.finish(row.id, { status: "FAILED", error: reason });
    return {
      status: "failed" as const,
      auditId: row.id,
      replayed: false,
      httpStatus: null,
      message: reason,
    };
  };
  if (!check.ok) return fail(check.error);
  if (mode === "rotate" && check.team.id !== existing!.teamId)
    return fail("team_changed");
  if (
    mode === "connect" &&
    (await teamConnectedElsewhere(
      actor.scope,
      input.installationId,
      check.team.id,
    ))
  )
    return fail("already_connected_elsewhere");

  const write = {
    teamId: check.team.id,
    teamSlug: check.team.slug,
    teamName: check.team.name,
    plan: check.team.plan,
    accessToken: encryptVercelToken(input.installationId, token),
    tokenHint: hint,
    tokenScope: check.scope,
    tokenExpiresAt: check.expiresAt,
    userId: actor.user.id,
  };
  if (mode === "connect") {
    const created = await createVercelConnection(
      actor.scope,
      input.installationId,
      write,
    );
    if (created === "taken") return fail("already_connected_elsewhere");
  } else if (
    !(await rotateVercelConnection(actor.scope, input.installationId, write))
  ) {
    return fail("team_changed");
  }
  await session.finish(row.id, { status: "SUCCEEDED" });
  session.revalidate();
  try {
    deps.schedule?.(input.installationId);
  } catch {
    // Scheduling is best effort; the next reconcile picks it up.
  }
  return {
    status: "succeeded",
    auditId: row.id,
    replayed: false,
    data: {
      teamSlug: check.team.slug,
      teamName: check.team.name,
      scope: check.scope,
    },
  };
}

export function defaultVercelDeps(
  overrides: Partial<VercelDeps> = {},
): VercelDeps {
  return { ...defaultActionDeps(), ...overrides };
}

export async function connectVercel(
  actor: ActionActor,
  input: ConnectInput,
  deps: VercelDeps = defaultVercelDeps(),
): Promise<ConnectResult> {
  return storeToken("connect", actor, input, deps);
}

export async function rotateVercelToken(
  actor: ActionActor,
  input: ConnectInput,
  deps: VercelDeps = defaultVercelDeps(),
): Promise<ConnectResult> {
  return storeToken("rotate", actor, input, deps);
}

/** VERCEL_DISCONNECT: TYPED with the team slug; deletes the stored data, keeps the audit rows. */
export async function disconnectVercel(
  actor: ActionActor,
  input: {
    installationId: bigint;
    typed: string;
    idempotencyKey: string;
  },
  deps: VercelDeps = defaultVercelDeps(),
): Promise<ActionResult<null>> {
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: "VERCEL_DISCONNECT",
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
  const existing = await findVercelConnection(
    actor.scope,
    input.installationId,
  );
  if (!existing) return invalid("not_connected");
  if (
    !session.confirm({
      kind: "TYPED",
      typed: input.typed,
      expected: existing.teamSlug,
    })
  )
    return { status: "confirmation_mismatch" };
  const row = await session.record({
    params: {
      teamId: existing.teamId,
      teamSlug: existing.teamSlug,
      tokenSource: existing.tokenSource,
    },
    actingAs: null,
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };
  const outcome = await session.perform(row.id, async () => {
    await deleteVercelConnection(actor.scope, input.installationId);
    return { data: null };
  });
  session.revalidate();
  return outcome;
}

/** VERCEL_PROJECT_LINK: sets or clears the manual repository of a project. */
export async function linkVercelProject(
  actor: ActionActor,
  input: {
    installationId: bigint;
    projectId: string;
    repositoryId: bigint | null;
    confirmed: boolean;
    idempotencyKey: string;
  },
  deps: VercelDeps = defaultVercelDeps(),
): Promise<ActionResult<{ repositoryId: string | null }>> {
  // Resolve first: a project of another installation answers 404.
  const project = await findVercelProject(
    actor.scope,
    input.installationId,
    input.projectId,
  );
  const repo =
    input.repositoryId !== null
      ? await findLinkableRepository(
          actor.scope,
          input.installationId,
          input.repositoryId,
        )
      : null;
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: "VERCEL_PROJECT_LINK",
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: {
        type: "vercel_project",
        id: project.id,
        repositoryId: repo?.id ?? null,
        repoFullName: repo?.fullName ?? null,
      },
      confirmation: "DIALOG",
      requiresManagement: false,
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };
  if (input.repositoryId !== null && !repo)
    return { status: "refused", reason: "invalid_repository" };
  const before = project.manualRepositoryId;
  if ((before ?? null) === (repo?.id ?? null))
    return { status: "refused", reason: "unchanged" };
  const row = await session.record({
    params: {
      projectId: project.id,
      before: before != null ? String(before) : null,
      after: repo ? String(repo.id) : null,
    },
    actingAs: null,
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };
  const outcome = await session.perform(row.id, async () => {
    await setVercelProjectLink(
      actor.scope,
      input.installationId,
      project.id,
      repo?.id ?? null,
    );
    return { data: { repositoryId: repo ? String(repo.id) : null } };
  });
  session.revalidate();
  return outcome;
}
