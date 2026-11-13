import "server-only";
import { env } from "@/env";
import {
  beginAction,
  defaultActionDeps,
  type ActionActor,
  type ActionDeps,
  type ActionResult,
  type ActionSession,
} from "@/server/authz/action";
import { AzureError, type Fetch } from "@/server/azure/client";
import { isGuid } from "@/server/azure/entra";
import { createAzureWriteClient } from "@/server/azure/write";
import {
  clearAzureHookSubscriptions,
  createAzureConnection,
  deleteAzureConnection,
  findAzureConnection,
  findAzureDefinition,
  findLinkableRepo,
  listAzureHookSubscriptions,
  listAzureProjectsFor,
  orgConnectedElsewhere,
  rotateAzureConnection,
  setAzureDefinitionLink,
  setAzureDefinitionOs,
  setAzureHookCredentials,
  setAzureHookSubscriptions,
  setAzureLimits,
  setAzureProjectSelection,
  type AzureLimits,
} from "@/server/data/azure";
import {
  checkAzureCredential,
  installationRepoNames,
  storeProjects,
  type AzureCheckError,
} from "@/server/ingest/azure-connect";
import {
  azureCredentialFor,
  decryptAzureSecret,
  encryptAzureSecret,
  secretHintOf,
  type PlainAzureCredential,
} from "@/server/ingest/azure-credential";
import {
  newHookCredentials,
  HOOK_PREVIOUS_SECRET_MS,
} from "@/server/ingest/azure-hook";
import { hookUrlPrefix } from "@/server/ingest/azure-reconcile";
import { scrubKnown } from "@/server/ingest/webhook";

/**
 * The admin settings of "CI · Azure DevOps" (design addendum M7 §3),
 * through the management pipeline (idempotency, rate limit, DENIED rows,
 * the installation's audit chain). They change app data (and, for the
 * service hook, subscriptions in Azure DevOps), so they work while the
 * installation's management toggle is off (`requiresManagement: false`);
 * the global kill switch still applies.
 *
 * Credentials are validated with GETs before anything is stored (see
 * azure-connect.ts), stored encrypted and never written to the audit
 * params, errors or results: only their last 4 characters. Audit params
 * hold ids only (organisation and project GUIDs), never the organisation
 * or project names.
 */

export type AzureDeps = ActionDeps & {
  fetch?: Fetch;
  /** Schedules the first sync (`after()` in a request). */
  schedule?: (installationId: bigint) => void;
};

export function defaultAzureDeps(
  overrides: Partial<AzureDeps> = {},
): AzureDeps {
  return { ...defaultActionDeps(), ...overrides };
}

type Refusal =
  | AzureCheckError
  | "invalid_input"
  | "org_changed"
  | "already_connected"
  | "already_connected_elsewhere"
  | "not_connected"
  | "env_managed"
  | "invalid_repository"
  | "invalid_definition"
  | "unchanged"
  | "scope_missing_hooks"
  | "public_url_required";

function refused(reason: Refusal): ActionResult<never> {
  return { status: "refused", reason };
}

const PAT = /^[A-Za-z0-9._~+/=-]{20,256}$/;
const SECRET = /^[A-Za-z0-9._~+/=-]{8,512}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type ConnectInput = {
  installationId: bigint;
  /** Organisation name or URL (connect); ignored on rotate (the stored one). */
  org?: string;
  authKind: "PAT" | "ENTRA_SP";
  pat?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  /** "YYYY-MM-DD", admin-entered expiry of the PAT or secret. */
  expiresAt?: string | null;
  confirmed: boolean;
  idempotencyKey: string;
};

export type ConnectResult = ActionResult<{
  orgName: string;
  authKind: "PAT" | "ENTRA_SP";
  projects: number;
  suggested: number;
}>;

function plainOf(input: ConnectInput): PlainAzureCredential | null {
  if (input.authKind === "PAT") {
    const pat = input.pat?.trim() ?? "";
    return PAT.test(pat) ? { kind: "pat", pat } : null;
  }
  const tenantId = input.tenantId?.trim() ?? "";
  const clientId = input.clientId?.trim() ?? "";
  const clientSecret = input.clientSecret?.trim() ?? "";
  if (!isGuid(tenantId) || !isGuid(clientId) || !SECRET.test(clientSecret))
    return null;
  return {
    kind: "sp",
    tenantId: tenantId.toLowerCase(),
    clientId: clientId.toLowerCase(),
    clientSecret,
  };
}

function expiryOf(value: string | null | undefined): Date | null | "invalid" {
  if (!value) return null;
  if (!DAY.test(value)) return "invalid";
  const d = new Date(`${value}T23:59:59Z`);
  return Number.isFinite(d.getTime()) ? d : "invalid";
}

async function storeCredential(
  mode: "connect" | "rotate",
  actor: ActionActor,
  input: ConnectInput,
  deps: AzureDeps,
): Promise<ConnectResult> {
  const begun = await beginAction(
    actor,
    {
      installationId: input.installationId,
      action: mode === "connect" ? "ADO_CONNECT" : "ADO_TOKEN_ROTATE",
      role: "ADMIN",
      idempotencyKey: input.idempotencyKey,
      target: { type: "azure_org", id: String(input.installationId) },
      confirmation: "DIALOG",
      requiresManagement: false,
    },
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };

  const cred = plainOf(input);
  const expiresAt = expiryOf(input.expiresAt);
  if (!cred || expiresAt === "invalid") return refused("invalid_input");
  const existing = await findAzureConnection(actor.scope, input.installationId);
  if (mode === "connect" && existing) return refused("already_connected");
  if (mode === "rotate") {
    if (!existing) return refused("not_connected");
    if (existing.authKind === "ENV") return refused("env_managed");
  }
  const orgInput = mode === "rotate" ? existing!.orgName : (input.org ?? "");
  const secret = cred.kind === "pat" ? cred.pat : cred.clientSecret;
  const hint = secretHintOf(secret);
  const check = await checkAzureCredential(orgInput, cred, {
    fetch: deps.fetch,
    now: deps.now(),
    repoFullNames: await installationRepoNames(input.installationId),
  });
  const suggested = check.ok
    ? check.projects.filter((p) => p.suggested).map((p) => p.id)
    : [];
  // Every validated attempt leaves a row; a refused credential never reaches the DB.
  const row = await session.record({
    params: check.ok
      ? {
          orgId: check.orgId,
          authKind: input.authKind,
          tokenHint: hint,
          projectIds: mode === "connect" ? suggested : [],
          scopes: check.scopes,
        }
      : { authKind: input.authKind, tokenHint: hint },
    actingAs: `azure:${input.authKind === "PAT" ? "pat" : "sp"}:${hint}`,
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
  if (mode === "rotate" && check.orgId !== existing!.orgId)
    return fail("org_changed");
  if (
    mode === "connect" &&
    (await orgConnectedElsewhere(
      actor.scope,
      input.installationId,
      check.orgId,
    ))
  )
    return fail("already_connected_elsewhere");
  const write = {
    orgId: check.orgId,
    orgName: check.org,
    authKind: input.authKind,
    accessToken: encryptAzureSecret(
      input.installationId,
      "accessToken",
      secret,
    ),
    tokenHint: hint,
    tokenExpiresAt: expiresAt,
    tenantId: cred.kind === "sp" ? cred.tenantId : null,
    clientId: cred.kind === "sp" ? cred.clientId : null,
    scopes: {
      ...check.scopes,
      // A rotate keeps the probed execute and hook scopes.
      ...(mode === "rotate" && existing ? pickScopes(existing.scopes) : {}),
    },
    userId: actor.user.id,
  };
  if (mode === "connect") {
    const created = await createAzureConnection(
      actor.scope,
      input.installationId,
      write,
    );
    if (created === "taken") return fail("already_connected_elsewhere");
    await storeProjects(input.installationId, check.projects, {
      applySuggestion: true,
    });
  } else if (
    !(await rotateAzureConnection(actor.scope, input.installationId, write))
  ) {
    return fail("org_changed");
  }
  await session.finish(row.id, { status: "SUCCEEDED" });
  session.revalidate();
  try {
    deps.schedule?.(input.installationId);
  } catch {
    // Best effort; the next reconcile picks it up.
  }
  return {
    status: "succeeded",
    auditId: row.id,
    replayed: false,
    data: {
      orgName: check.org,
      authKind: input.authKind,
      projects: check.projects.length,
      suggested: suggested.length,
    },
  };
}

function pickScopes(scopes: unknown): Record<string, string> {
  const s = (scopes ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of ["execute", "hooks"])
    if (typeof s[k] === "string") out[k] = s[k] as string;
  return out;
}

export function connectAzure(
  actor: ActionActor,
  input: ConnectInput,
  deps = defaultAzureDeps(),
) {
  return storeCredential("connect", actor, input, deps);
}

/** Rotate the credential, or switch PAT ↔ service principal (same organisation; history kept). */
export function rotateAzureCredential(
  actor: ActionActor,
  input: ConnectInput,
  deps = defaultAzureDeps(),
) {
  return storeCredential("rotate", actor, input, deps);
}

/** Begins an admin settings action (DIALOG unless TYPED). */
async function beginAdmin(
  actor: ActionActor,
  installationId: bigint,
  action: Parameters<typeof beginAction>[1]["action"],
  idempotencyKey: string,
  deps: AzureDeps,
  confirmation: "DIALOG" | "TYPED" = "DIALOG",
  target: {
    type: string;
    id: string;
    repositoryId?: bigint | null;
    repoFullName?: string | null;
  } = {
    type: "azure_org",
    id: String(installationId),
  },
): Promise<
  | { ok: true; session: ActionSession }
  | { ok: false; result: ActionResult<never> }
> {
  const begun = await beginAction(
    actor,
    {
      installationId,
      action,
      role: "ADMIN",
      idempotencyKey,
      target,
      confirmation,
      requiresManagement: false,
    },
    deps,
  );
  return begun.ok
    ? { ok: true, session: begun.session }
    : { ok: false, result: begun.result };
}

/**
 * ADO_DISCONNECT: TYPED with the organisation name; deletes every Azure
 * DevOps row of the installation and its findings (owner decision 4); the
 * audit rows stay. Optionally deletes our service hook subscriptions first.
 */
export async function disconnectAzure(
  actor: ActionActor,
  input: {
    installationId: bigint;
    typed: string;
    deleteHooks?: boolean;
    idempotencyKey: string;
  },
  deps: AzureDeps = defaultAzureDeps(),
): Promise<ActionResult<{ hooksDeleted: number }>> {
  const begun = await beginAdmin(
    actor,
    input.installationId,
    "ADO_DISCONNECT",
    input.idempotencyKey,
    deps,
    "TYPED",
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  const existing = await findAzureConnection(actor.scope, input.installationId);
  if (!existing) return refused("not_connected");
  if (
    !session.confirm({
      kind: "TYPED",
      typed: input.typed,
      expected: existing.orgName,
    })
  )
    return { status: "confirmation_mismatch" };
  const row = await session.record({
    params: {
      orgId: existing.orgId,
      authKind: existing.authKind,
      deleteHooks: input.deleteHooks === true,
    },
    actingAs: null,
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };
  const outcome = await session.perform(row.id, async () => {
    let hooksDeleted = 0;
    if (input.deleteHooks) {
      const subs = await listAzureHookSubscriptions(
        actor.scope,
        input.installationId,
      );
      try {
        const cred = await azureCredentialFor(input.installationId, {
          fetch: deps.fetch,
        });
        if (cred.kind === "token") {
          const write = createAzureWriteClient({
            org: cred.org,
            auth: cred.auth,
            fetch: deps.fetch,
          });
          for (const s of subs) {
            await write
              .deleteHook(s.id)
              .then(() => hooksDeleted++)
              .catch(() => undefined);
          }
        }
      } catch {
        // Best effort: the purge goes on; the subscriptions fail on their own.
      }
    }
    await deleteAzureConnection(actor.scope, input.installationId);
    return { data: { hooksDeleted } };
  });
  session.revalidate();
  return outcome;
}

/** ADO_PROJECTS_SELECT: the projects whose pipelines are synced. */
export async function selectAzureProjects(
  actor: ActionActor,
  input: {
    installationId: bigint;
    projectIds: string[];
    confirmed: boolean;
    idempotencyKey: string;
  },
  deps: AzureDeps = defaultAzureDeps(),
): Promise<ActionResult<{ selected: number }>> {
  const begun = await beginAdmin(
    actor,
    input.installationId,
    "ADO_PROJECTS_SELECT",
    input.idempotencyKey,
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };
  const projects = await listAzureProjectsFor(
    actor.scope,
    input.installationId,
  );
  if (projects.length === 0) return refused("not_connected");
  const known = new Set(projects.map((p) => p.id));
  const wanted = [...new Set(input.projectIds.map((p) => p.toLowerCase()))];
  if (wanted.some((p) => !known.has(p))) return refused("invalid_input");
  const before = projects
    .filter((p) => p.selected)
    .map((p) => p.id)
    .sort();
  if (before.join(",") === [...wanted].sort().join(","))
    return refused("unchanged");
  const row = await session.record({
    params: { before, after: wanted.sort() },
    actingAs: null,
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };
  const outcome = await session.perform(row.id, async () => {
    await setAzureProjectSelection(actor.scope, input.installationId, wanted);
    return { data: { selected: wanted.length } };
  });
  session.revalidate();
  try {
    deps.schedule?.(input.installationId);
  } catch {
    // Best effort.
  }
  return outcome;
}

/** ADO_DEFINITION_LINK: sets or clears the manual repository of a definition. */
export async function linkAzureDefinition(
  actor: ActionActor,
  input: {
    installationId: bigint;
    projectId: string;
    definitionId: number;
    repositoryId: bigint | null;
    confirmed: boolean;
    idempotencyKey: string;
  },
  deps: AzureDeps = defaultAzureDeps(),
): Promise<ActionResult<{ repositoryId: string | null }>> {
  // Resolve first: a definition of another installation answers 404.
  const d = await findAzureDefinition(
    actor.scope,
    input.installationId,
    input.projectId,
    input.definitionId,
  );
  const repo =
    input.repositoryId !== null
      ? await findLinkableRepo(
          actor.scope,
          input.installationId,
          input.repositoryId,
        )
      : null;
  const begun = await beginAdmin(
    actor,
    input.installationId,
    "ADO_DEFINITION_LINK",
    input.idempotencyKey,
    deps,
    "DIALOG",
    {
      type: "azure_definition",
      id: `${d.projectId}:${d.id}`,
      repositoryId: repo?.id ?? null,
      repoFullName: repo?.fullName ?? null,
    },
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };
  if (input.repositoryId !== null && !repo)
    return refused("invalid_repository");
  if ((d.manualRepositoryId ?? null) === (repo?.id ?? null))
    return refused("unchanged");
  const row = await session.record({
    params: {
      projectId: d.projectId,
      definitionId: d.id,
      before:
        d.manualRepositoryId != null ? String(d.manualRepositoryId) : null,
      after: repo ? String(repo.id) : null,
    },
    actingAs: null,
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };
  const outcome = await session.perform(row.id, async () => {
    await setAzureDefinitionLink(
      actor.scope,
      input.installationId,
      d.projectId,
      d.id,
      repo?.id ?? null,
    );
    return { data: { repositoryId: repo ? String(repo.id) : null } };
  });
  session.revalidate();
  return outcome;
}

/** ADO_DEFINITION_OS_SET: overrides the OS of a definition's jobs (or clears it). */
export async function setAzureDefinitionOsAction(
  actor: ActionActor,
  input: {
    installationId: bigint;
    projectId: string;
    definitionId: number;
    os: "LINUX" | "WINDOWS" | "MACOS" | null;
    confirmed: boolean;
    idempotencyKey: string;
  },
  deps: AzureDeps = defaultAzureDeps(),
): Promise<ActionResult<{ os: string | null }>> {
  const d = await findAzureDefinition(
    actor.scope,
    input.installationId,
    input.projectId,
    input.definitionId,
  );
  const begun = await beginAdmin(
    actor,
    input.installationId,
    "ADO_DEFINITION_OS_SET",
    input.idempotencyKey,
    deps,
    "DIALOG",
    {
      type: "azure_definition",
      id: `${d.projectId}:${d.id}`,
    },
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };
  if ((d.osOverride ?? null) === (input.os ?? null))
    return refused("unchanged");
  const row = await session.record({
    params: {
      projectId: d.projectId,
      definitionId: d.id,
      before: d.osOverride,
      after: input.os,
    },
    actingAs: null,
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };
  const outcome = await session.perform(row.id, async () => {
    await setAzureDefinitionOs(
      actor.scope,
      input.installationId,
      d.projectId,
      d.id,
      input.os,
    );
    return { data: { os: input.os } };
  });
  session.revalidate();
  return outcome;
}

/**
 * ADO_LIMITS_UPDATE: parallel jobs, included minutes (null = paid),
 * job time limit, reset day and the quota block; `adopt` takes what
 * resourceusage detected. The stored values stay the source of truth.
 */
export async function updateAzureLimits(
  actor: ActionActor,
  input: {
    installationId: bigint;
    limits?: AzureLimits;
    adopt?: boolean;
    confirmed: boolean;
    idempotencyKey: string;
  },
  deps: AzureDeps = defaultAzureDeps(),
): Promise<ActionResult<AzureLimits>> {
  const begun = await beginAdmin(
    actor,
    input.installationId,
    "ADO_LIMITS_UPDATE",
    input.idempotencyKey,
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };
  const c = await findAzureConnection(actor.scope, input.installationId);
  if (!c) return refused("not_connected");
  const before: AzureLimits = {
    hostedParallelJobs: c.hostedParallelJobs,
    includedMinutes: c.includedMinutes,
    maxJobMinutes: c.maxJobMinutes,
    monthResetDay: c.monthResetDay,
    blockWhenQuotaExhausted: c.blockWhenQuotaExhausted,
  };
  let after: AzureLimits;
  if (input.adopt) {
    const d = (c.detectedLimits ?? {}) as {
      totalMinutes?: number | null;
      totalCount?: number | null;
      isPremium?: boolean | null;
    };
    if (d.totalMinutes == null && d.totalCount == null && d.isPremium == null)
      return refused("unchanged");
    const paid = d.isPremium === true;
    after = {
      ...before,
      hostedParallelJobs:
        d.totalCount != null && d.totalCount > 0
          ? Math.round(d.totalCount)
          : before.hostedParallelJobs,
      includedMinutes: paid
        ? null
        : d.totalMinutes != null && d.totalMinutes > 0
          ? Math.round(d.totalMinutes)
          : before.includedMinutes,
      maxJobMinutes: paid ? 360 : before.maxJobMinutes,
    };
  } else {
    const l = input.limits;
    if (
      !l ||
      !Number.isInteger(l.hostedParallelJobs) ||
      l.hostedParallelJobs < 0 ||
      l.hostedParallelJobs > 1000 ||
      (l.includedMinutes != null &&
        (!Number.isInteger(l.includedMinutes) ||
          l.includedMinutes < 0 ||
          l.includedMinutes > 1_000_000)) ||
      !Number.isInteger(l.maxJobMinutes) ||
      l.maxJobMinutes < 1 ||
      l.maxJobMinutes > 4320 ||
      !Number.isInteger(l.monthResetDay) ||
      l.monthResetDay < 1 ||
      l.monthResetDay > 28
    )
      return refused("invalid_input");
    after = {
      ...l,
      blockWhenQuotaExhausted: l.blockWhenQuotaExhausted === true,
    };
  }
  if (JSON.stringify(before) === JSON.stringify(after))
    return refused("unchanged");
  const row = await session.record({
    params: { before, after, adopted: input.adopt === true },
    actingAs: null,
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };
  const outcome = await session.perform(row.id, async () => {
    await setAzureLimits(actor.scope, input.installationId, after);
    return { data: after };
  });
  session.revalidate();
  return outcome;
}

export type HookSetup = {
  url: string;
  username: string;
  /**
   * Shown once, when it is made; never stored in plaintext or written to the
   * audit row. `null` when an existing secret is kept (rotate for a new one).
   */
  password: string | null;
  subscriptions: number;
  mode: "auto" | "manual";
};

const HOOK_EVENTS = [
  "ms.vss-pipelines.run-state-changed-event",
  "ms.vss-pipelines.job-state-changed-event",
] as const;

/**
 * ADO_HOOKS_INSTALL: creates the route key and secret (if none yet) and,
 * in "auto" mode, our service hook subscriptions for every selected project
 * (needs Service Hooks: Read & write; replaces the ones we made before). In
 * "manual" mode only the credentials are made, for a guided setup. A new
 * secret is returned once; an existing one is kept and not shown again
 * (`password: null`), and the previous-secret window of a rotation stays.
 */
export async function installAzureHooks(
  actor: ActionActor,
  input: {
    installationId: bigint;
    mode: "auto" | "manual";
    confirmed: boolean;
    idempotencyKey: string;
  },
  deps: AzureDeps = defaultAzureDeps(),
): Promise<ActionResult<HookSetup>> {
  const begun = await beginAdmin(
    actor,
    input.installationId,
    "ADO_HOOKS_INSTALL",
    input.idempotencyKey,
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };
  const c = await findAzureConnection(actor.scope, input.installationId);
  if (!c) return refused("not_connected");
  if (!/^https:\/\//.test(env.NEXT_PUBLIC_APP_URL))
    return refused("public_url_required");
  const projects = (
    await listAzureProjectsFor(actor.scope, input.installationId)
  ).filter((p) => p.selected);
  const row = await session.record({
    params: { mode: input.mode, projectIds: projects.map((p) => p.id).sort() },
  });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };
  // An existing secret is kept and never shown again; only rotate (or
  // disconnect) changes it or the previous-secret window.
  const existing = Boolean(c.hookKey && c.hookSecret);
  const creds = existing
    ? {
        hookKey: c.hookKey as string,
        secret: decryptAzureSecret(
          input.installationId,
          "hookSecret",
          c.hookSecret as string,
        ),
      }
    : newHookCredentials();
  const shown = existing ? null : creds.secret;
  const url = `${hookUrlPrefix()}${creds.hookKey}`;
  if (!existing)
    await setAzureHookCredentials(actor.scope, input.installationId, {
      hookKey: creds.hookKey,
      hookSecret: encryptAzureSecret(
        input.installationId,
        "hookSecret",
        creds.secret,
      ),
      hookSecretPrev: null,
      hookSecretPrevUntil: null,
    });
  if (input.mode === "manual") {
    await session.finish(row.id, { status: "SUCCEEDED" });
    session.revalidate();
    return {
      status: "succeeded",
      auditId: row.id,
      replayed: false,
      data: {
        url,
        username: creds.hookKey,
        password: shown,
        subscriptions: 0,
        mode: "manual",
      },
    };
  }
  const outcome = await session.executeAzure(
    row.id,
    async ({ write, secrets }) => {
      secrets.push(creds.secret);
      const old = await listAzureHookSubscriptions(
        actor.scope,
        input.installationId,
      );
      for (const s of old) await write.deleteHook(s.id).catch(() => undefined);
      await clearAzureHookSubscriptions(
        actor.scope,
        input.installationId,
        old.map((s) => s.id),
      );
      const made: Array<{ id: string; eventType: string; projectId: string }> =
        [];
      let last: { status: number; activityId: string | null } = {
        status: 200,
        activityId: null,
      };
      try {
        for (const p of projects)
          for (const eventType of HOOK_EVENTS) {
            const r = await write.createHook({
              projectId: p.id,
              eventType,
              url,
              username: creds.hookKey,
              password: creds.secret,
            });
            last = r;
            if (r.id) made.push({ id: r.id, eventType, projectId: p.id });
          }
      } catch (error) {
        if (error instanceof AzureError && error.code === "forbidden") {
          await setAzureHookSubscriptions(
            actor.scope,
            input.installationId,
            made,
            false,
            deps.now(),
          );
          throw new AzureError(
            403,
            "forbidden",
            "scope_missing_hooks",
            error.activityId,
            error.path,
          );
        }
        throw error;
      }
      await setAzureHookSubscriptions(
        actor.scope,
        input.installationId,
        made,
        true,
        deps.now(),
      );
      return {
        data: {
          url,
          username: creds.hookKey,
          password: shown,
          subscriptions: made.length,
          mode: "auto" as const,
        },
        httpStatus: last.status,
        requestId: last.activityId,
      };
    },
  );
  session.revalidate();
  return outcome.status === "failed"
    ? { ...outcome, message: scrubKnown(outcome.message, [creds.secret], 300) }
    : outcome;
}

/**
 * ADO_HOOK_SECRET_ROTATE: a new secret; the previous one keeps working for
 * 7 days (update the subscriptions with "Create subscriptions" again or by
 * hand). The new secret is returned once.
 */
export async function rotateAzureHookSecret(
  actor: ActionActor,
  input: { installationId: bigint; confirmed: boolean; idempotencyKey: string },
  deps: AzureDeps = defaultAzureDeps(),
): Promise<ActionResult<HookSetup>> {
  const begun = await beginAdmin(
    actor,
    input.installationId,
    "ADO_HOOK_SECRET_ROTATE",
    input.idempotencyKey,
    deps,
  );
  if (!begun.ok) return begun.result;
  const { session } = begun;
  if (!session.confirm({ kind: "DIALOG", confirmed: input.confirmed }))
    return { status: "confirmation_mismatch" };
  const c = await findAzureConnection(actor.scope, input.installationId);
  if (!c) return refused("not_connected");
  if (!c.hookKey || !c.hookSecret) return refused("not_connected");
  const row = await session.record({ params: {}, actingAs: null });
  if (!row.created)
    return { status: "pending", auditId: row.id, replayed: true };
  const { secret } = newHookCredentials();
  const outcome = await session.perform(row.id, async () => {
    await setAzureHookCredentials(actor.scope, input.installationId, {
      hookKey: c.hookKey!,
      hookSecret: encryptAzureSecret(
        input.installationId,
        "hookSecret",
        secret,
      ),
      // Re-encrypted under its own column binding.
      hookSecretPrev: encryptAzureSecret(
        input.installationId,
        "hookSecretPrev",
        decryptAzureSecret(input.installationId, "hookSecret", c.hookSecret!),
      ),
      hookSecretPrevUntil: new Date(
        deps.now().getTime() + HOOK_PREVIOUS_SECRET_MS,
      ),
    });
    return {
      data: {
        url: `${hookUrlPrefix()}${c.hookKey}`,
        username: c.hookKey!,
        password: secret,
        subscriptions: 0,
        mode: "manual" as const,
      },
    };
  });
  session.revalidate();
  return outcome;
}
