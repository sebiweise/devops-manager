import "server-only";
import { revalidateTag } from "next/cache";
import { env } from "@/env";
import type { AuditAction, Prisma } from "@/generated/prisma/client";
import {
  actorProviderOf,
  appendAudit,
  completeAudit,
  type AuditCompletion,
} from "@/server/audit/log";
import { inScope, NotFoundError } from "@/server/data/installations";
import { db } from "@/server/db";
import { actingAs } from "@/server/github/app";
import { githubErrorInfo } from "@/server/github/errors";
import {
  missingOf,
  PermissionNotGrantedError,
  type TokenPurpose,
} from "@/server/github/purposes";
import type { GitHubApi, GitHubClients } from "@/server/ingest/github-client";
import { githubClients } from "@/server/ingest/triggers";
import { vercelCredentialFor } from "@/server/ingest/vercel-credential";
import { noteVercelFailure } from "@/server/ingest/vercel-reconcile";
import { redactError, scrubKnown } from "@/server/ingest/webhook";
import {
  createVercelClient,
  type Fetch,
  type VercelReadApi,
} from "@/server/vercel/client";
import {
  createVercelWriteClient,
  vercelWriteErrorInfo,
  type VercelWriteApi,
} from "@/server/vercel/write";
import { createAzureClient, type AzureReadApi } from "@/server/azure/client";
import {
  azureErrorInfo,
  createAzureWriteClient,
  type AzureWriteApi,
} from "@/server/azure/write";
import { azureCredentialFor } from "@/server/ingest/azure-credential";
import { noteAzureFailure } from "@/server/ingest/azure-reconcile";
import { consumeActionTokens } from "./rate-limit";
import { hasRole, type Role } from "./roles";
import { currentRole, type TenantScope } from "./scope";

/**
 * The single management pipeline (design §8.1), used by every management
 * Server Action:
 *
 * 1. Session and Origin check: done by the Server Action wrapper
 *    (src/server/authz/request.ts) before it builds the actor.
 * 2. Input validation (zod) and entity resolution from the DB: done by the
 *    caller; `beginAction` then requires the installation to be in the
 *    actor's TenantScope, otherwise NotFoundError (404).
 * -  Gates: the global kill switch `MANAGEMENT_ENABLED` and the
 *    per-installation `managementEnabled` toggle (403).
 * 3. Idempotency: an existing audit row with the key answers with its result
 *    and nothing else happens.
 * 4. Live authz: the role is re-resolved from the DB and env (no session
 *    cache). No role: 401 and the user's sessions are revoked. Too low: a
 *    DENIED audit row and 403; the denial spends a rate-limit token first,
 *    and without one it is answered as rate limited and not recorded. The
 *    App must hold the purpose's permissions (refreshed from GitHub when
 *    older than 10 minutes); otherwise "permission not granted" and no
 *    GitHub call.
 * 5. Rate limit: 30 mutations per minute per user, one token per bulk item.
 * 6. Confirmation: `ActionSession.confirm` (TYPED must equal the variable or
 *    repo name).
 * 7. Audit PENDING row (hash-chained) with the app user, role, provider and
 *    `actingAs = app:<slug>[bot]`: `ActionSession.record`.
 * 8. Execute with an installation token from the token broker (`act.*`
 *    purpose, narrowed to the target repos, never cached):
 *    `ActionSession.execute`.
 * 9. Audit result (status, HTTP status, x-github-request-id, GitHub's
 *    message verbatim) and cache revalidation. Callers re-read the entity
 *    from GitHub instead of writing optimistic DB state.
 *
 * Because the App acts for everyone, GitHub never checks the user's own
 * repository permission: the app role is the only user-level gate and the
 * App's granted permissions are the ceiling.
 *
 * Generalised additively for other providers (design addendum §8.1):
 * `provider: "vercel"` adds the Vercel gate (connection, its own toggle)
 * and answers every closed gate with `unavailable` plus a DENIED row;
 * `actingAs` names the identity when it is not the App; `perform` takes a
 * `mapError` for the provider's error shape; `auditChain: "instance"` sends
 * the rows to chain 0. M7b adds `provider: "azure"` through the same
 * table-driven `providerGate` (env AZURE_MANAGEMENT_ENABLED, the
 * installation toggle, the connection, its rate headroom, its own toggle
 * and the execute scope). GitHub actions behave exactly as before.
 */

export type ActionActor = {
  user: { id: string; name: string; email: string };
  scope: TenantScope;
  ipHash?: string | null;
  userAgent?: string | null;
};

export type ActionDeps = {
  clients: GitHubClients;
  now: () => Date;
  /** The global kill switch (MANAGEMENT_ENABLED). */
  managementEnabled: boolean;
  /** Adds `DevOps-Manager-Audit: <auditId>` to merge commits. */
  mergeAuditTrailer: boolean;
  revalidate: (installationId: bigint) => void;
  /** The fetch of Vercel calls (tests inject an in-memory Vercel). */
  vercelFetch?: Fetch;
  /** The Azure Pipelines kill switch (AZURE_MANAGEMENT_ENABLED, default off). */
  azureManagementEnabled?: boolean;
  /** The fetch of Azure DevOps (and Entra) calls (tests inject a fake). */
  azureFetch?: Fetch;
};

export function defaultActionDeps(
  overrides: Partial<ActionDeps> = {},
): ActionDeps {
  return {
    clients: githubClients,
    now: () => new Date(),
    managementEnabled: env.MANAGEMENT_ENABLED,
    mergeAuditTrailer: env.MERGE_AUDIT_TRAILER,
    azureManagementEnabled: env.AZURE_MANAGEMENT_ENABLED,
    revalidate: (id) => revalidateTag(`inst:${id}`, "max"),
    ...overrides,
  };
}

/** Results that end an action before (or instead of) a GitHub call. */
export type Denial =
  | { status: "unauthorized" }
  | { status: "forbidden" }
  | { status: "management_disabled"; level: "global" | "installation" }
  | { status: "permission_not_granted"; missing: string[] }
  | { status: "rate_limited"; retryAfterS: number }
  | { status: "confirmation_mismatch" }
  /**
   * A provider gate is closed (design addendum §8.1): for Vercel actions one
   * of the three toggles is off, or the connection is missing or revoked.
   * Recorded as a DENIED row (unlike `management_disabled` of GitHub actions).
   */
  | { status: "unavailable"; reason: UnavailableReason }
  /** The idempotency key belongs to another user or installation. */
  | { status: "conflict" }
  | {
      status: "refused";
      reason: string;
      detail?: Record<string, string | number | boolean | null>;
    };

export type Outcome<T> =
  | { status: "succeeded"; auditId: string; replayed: boolean; data: T | null }
  | {
      status: "failed";
      auditId: string;
      replayed: boolean;
      httpStatus: number | null;
      /** GitHub's message, verbatim. */
      message: string;
      /** Partial results (bulk actions). */
      data?: T | null;
    }
  /** A replay while the first submit is still running. */
  | { status: "pending"; auditId: string; replayed: true };

export type ActionResult<T = null> = Outcome<T> | Denial;

export const UNAVAILABLE_REASONS = [
  "management_disabled_global",
  "management_disabled_installation",
  "vercel_not_connected",
  "vercel_revoked",
  "vercel_management_disabled",
  "azure_management_disabled_global",
  "azure_not_connected",
  "azure_revoked",
  "azure_rate_limited",
  "azure_management_disabled",
  "azure_scope_missing",
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/** The error text of a DENIED row written for an `unavailable` gate. */
const UNAVAILABLE_PREFIX = "unavailable:";

export type AuditTarget = {
  type: string;
  id: string;
  repositoryId?: bigint | null;
  repoFullName?: string | null;
};

export type Confirmation =
  | { kind: "DIALOG"; confirmed: boolean }
  | { kind: "TYPED"; typed: string; expected: string };

export type GateSpec = {
  installationId: bigint;
  action: AuditAction;
  role: Role;
  idempotencyKey: string;
  target: AuditTarget;
  /** NONE: a step of a flow without its own confirmation (OAuth callback). */
  confirmation: "DIALOG" | "TYPED" | "NONE";
  /** The token purpose whose permissions the App must hold. */
  purpose?: TokenPurpose;
  /** False for local settings that must work while management is off. */
  requiresManagement?: boolean;
  /** Rate-limit tokens (one per bulk item). */
  cost?: number;
  /**
   * The provider the action calls (default "github"). "vercel" adds one gate
   * after the role check: the installation's Vercel connection exists, is
   * not revoked and has its own management toggle on; the global kill
   * switch and the installation toggle answer the same way there
   * (`unavailable` plus a DENIED row).
   */
  provider?: "github" | "vercel" | "azure";
  /**
   * Who performs the action when it is not the App (e.g.
   * "vercel:token:<hint>"); used by `record()` when the row gives none.
   */
  actingAs?: string;
  /**
   * The audit chain of the rows: the installation's (default) or the
   * instance-level chain 0 (personal billing credentials, design §3.4).
   */
  auditChain?: "installation" | "instance";
};

export type ActionInstallation = {
  id: bigint;
  accountLogin: string;
  accountType: "USER" | "ORGANIZATION";
  permissions: Record<string, unknown>;
  managementEnabled: boolean;
  redactVariableValues: boolean;
};

export type BeginResult =
  | { ok: true; session: ActionSession }
  | {
      ok: false;
      result: ActionResult<never>;
      /** The existing audit row when the idempotency key was replayed. */
      replayOf?: string;
    };

const PERMISSIONS_MAX_AGE_MS = 10 * 60 * 1000;

type ReplayRow = {
  id: string;
  installationId: bigint;
  actorUserId: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "DENIED";
  httpStatus: number | null;
  error: string | null;
};

function replayResult(row: ReplayRow): ActionResult<never> {
  switch (row.status) {
    case "DENIED": {
      const reason = row.error?.startsWith(UNAVAILABLE_PREFIX)
        ? row.error.slice(UNAVAILABLE_PREFIX.length)
        : null;
      return reason &&
        (UNAVAILABLE_REASONS as readonly string[]).includes(reason)
        ? { status: "unavailable", reason: reason as UnavailableReason }
        : { status: "forbidden" };
    }
    case "PENDING":
      return { status: "pending", auditId: row.id, replayed: true };
    case "SUCCEEDED":
      return {
        status: "succeeded",
        auditId: row.id,
        replayed: true,
        data: null,
      };
    case "FAILED":
      return {
        status: "failed",
        auditId: row.id,
        replayed: true,
        httpStatus: row.httpStatus,
        message: row.error ?? "",
      };
  }
}

/** The stored result of an idempotency key, or null when it is unused. */
export async function replayOf(
  actor: ActionActor,
  installationId: bigint,
  idempotencyKey: string,
): Promise<{ result: ActionResult<never>; auditId: string } | null> {
  const row = await db.auditLog.findUnique({
    where: { idempotencyKey },
    select: {
      id: true,
      installationId: true,
      actorUserId: true,
      status: true,
      httpStatus: true,
      error: true,
    },
  });
  if (!row) return null;
  if (
    row.actorUserId !== actor.user.id ||
    row.installationId !== installationId
  )
    return { result: { status: "conflict" }, auditId: row.id };
  return { result: replayResult(row), auditId: row.id };
}

async function loadInstallation(
  installationId: bigint,
): Promise<
  (ActionInstallation & { permissionsCheckedAt: Date | null }) | null
> {
  const inst = await db.installation.findFirst({
    where: { id: installationId, deletedAt: null, suspendedAt: null },
    select: {
      id: true,
      accountLogin: true,
      accountType: true,
      permissions: true,
      permissionsCheckedAt: true,
      managementEnabled: true,
      redactVariableValues: true,
    },
  });
  if (!inst) return null;
  return {
    ...inst,
    permissions: (inst.permissions ?? {}) as Record<string, unknown>,
  };
}

/**
 * Re-reads the installation's granted permissions from GitHub (App JWT) when
 * the stored copy is older than 10 minutes. A failed refresh keeps the
 * stored permissions; GitHub still enforces the real ones.
 */
async function freshPermissions(
  inst: ActionInstallation & { permissionsCheckedAt: Date | null },
  deps: ActionDeps,
): Promise<Record<string, unknown>> {
  const now = deps.now();
  if (
    inst.permissionsCheckedAt &&
    now.getTime() - inst.permissionsCheckedAt.getTime() < PERMISSIONS_MAX_AGE_MS
  )
    return inst.permissions;
  try {
    const res = await deps.clients
      .app()
      .request<{ permissions?: Record<string, unknown> }>(
        "GET /app/installations/{installation_id}",
        { installation_id: Number(inst.id) },
      );
    const permissions = Object.fromEntries(
      Object.entries(res.data.permissions ?? {}).filter(
        ([, v]) => typeof v === "string",
      ),
    );
    await db.installation.update({
      where: { id: inst.id },
      data: {
        permissions: permissions as Prisma.InputJsonValue,
        permissionsCheckedAt: now,
      },
    });
    return permissions;
  } catch (error) {
    console.error(
      "installation permissions not refreshed",
      githubErrorInfo(error).status ?? "unknown",
    );
    return inst.permissions;
  }
}

/**
 * The Vercel gate (design addendum §8.1, D5): the global kill switch, the
 * installation toggle (unless the action does not require it), and the
 * connection with its own management toggle, off by default.
 */
async function vercelGate(
  inst: ActionInstallation,
  spec: GateSpec,
  deps: ActionDeps,
): Promise<UnavailableReason | null> {
  if (!deps.managementEnabled) return "management_disabled_global";
  if (spec.requiresManagement !== false && !inst.managementEnabled)
    return "management_disabled_installation";
  const conn = await db.vercelConnection.findUnique({
    where: { installationId: inst.id },
    select: { revokedAt: true, managementEnabled: true },
  });
  if (!conn) return "vercel_not_connected";
  if (conn.revokedAt) return "vercel_revoked";
  if (!conn.managementEnabled) return "vercel_management_disabled";
  return null;
}

/** Azure DevOps rate headroom below which actions wait (TSTU share). */
const AZURE_MIN_HEADROOM = 0.1;

/**
 * The Azure Pipelines gate (design addendum M7 §7.1), in this order:
 * MANAGEMENT_ENABLED and AZURE_MANAGEMENT_ENABLED (env, default off), the
 * installation toggle, a connection, not revoked, not paused and at least
 * 10 % of the rate budget (TSTU) left, the connection's own toggle, and the
 * execute scope (probed when the toggle was turned on).
 */
async function azureGate(
  inst: ActionInstallation,
  spec: GateSpec,
  deps: ActionDeps,
): Promise<UnavailableReason | null> {
  if (!deps.managementEnabled) return "management_disabled_global";
  if (deps.azureManagementEnabled !== true)
    return "azure_management_disabled_global";
  if (spec.requiresManagement !== false && !inst.managementEnabled)
    return "management_disabled_installation";
  const conn = await db.azureDevOpsConnection.findUnique({
    where: { installationId: inst.id },
    select: {
      revokedAt: true,
      pausedUntil: true,
      managementEnabled: true,
      scopes: true,
    },
  });
  if (!conn) return "azure_not_connected";
  if (conn.revokedAt) return "azure_revoked";
  const now = deps.now();
  if (conn.pausedUntil && conn.pausedUntil > now) return "azure_rate_limited";
  const rate = await db.installationRateLimit.findUnique({
    where: {
      installationId_resource: { installationId: inst.id, resource: "azure" },
    },
    select: { limit: true, remaining: true, resetAt: true },
  });
  if (
    rate &&
    rate.limit > 0 &&
    rate.resetAt > now &&
    rate.remaining < rate.limit * AZURE_MIN_HEADROOM
  )
    return "azure_rate_limited";
  if (!conn.managementEnabled) return "azure_management_disabled";
  const scopes = (conn.scopes ?? {}) as Record<string, unknown>;
  if (scopes.execute !== "ok") return "azure_scope_missing";
  return null;
}

/** The provider gates, table-driven (GitHub has none: its toggles answer earlier). */
const providerGate: Record<
  "vercel" | "azure",
  (
    inst: ActionInstallation,
    spec: GateSpec,
    deps: ActionDeps,
  ) => Promise<UnavailableReason | null>
> = { vercel: vercelGate, azure: azureGate };

/** The permissions a purpose lacks on this installation, or null when granted. */
export const missingPermissions = missingOf;

/**
 * Steps 2 to 5 of the pipeline. Throws NotFoundError for an installation
 * outside the scope; every other refusal is a result.
 */
export async function beginAction(
  actor: ActionActor,
  spec: GateSpec,
  deps: ActionDeps = defaultActionDeps(),
): Promise<BeginResult> {
  if (!inScope(actor.scope, spec.installationId)) throw new NotFoundError();
  const inst = await loadInstallation(spec.installationId);
  if (!inst) throw new NotFoundError();

  const provider = spec.provider ?? "github";
  const external = provider !== "github";
  // GitHub actions: the toggles answer before anything is recorded (M3).
  // Vercel and Azure actions check them after the role, as a DENIED row (§8.1).
  if (!external && !deps.managementEnabled)
    return {
      ok: false,
      result: { status: "management_disabled", level: "global" },
    };
  if (!external && spec.requiresManagement !== false && !inst.managementEnabled)
    return {
      ok: false,
      result: { status: "management_disabled", level: "installation" },
    };

  const chainId = spec.auditChain === "instance" ? 0n : inst.id;
  const replay = await replayOf(actor, chainId, spec.idempotencyKey);
  if (replay)
    return { ok: false, result: replay.result, replayOf: replay.auditId };

  const role = await currentRole(actor.user.id);
  if (!role) {
    await db.session.deleteMany({ where: { userId: actor.user.id } });
    return { ok: false, result: { status: "unauthorized" } };
  }
  const actorProvider = await actorProviderOf(actor.user.id);
  const session = new ActionSession(
    actor,
    spec,
    inst,
    role,
    actorProvider,
    deps,
  );

  if (!hasRole(role, spec.role)) {
    // A denial spends a rate-limit token before its audit row is written, so
    // a user below the required role cannot grow the chain without bound
    // (each row takes the installation's advisory lock).
    const denied = await consumeActionTokens(actor.user.id, 1, deps.now());
    if (!denied.ok)
      return {
        ok: false,
        result: { status: "rate_limited", retryAfterS: denied.retryAfterS },
      };
    await session.record({ params: {}, status: "DENIED" });
    return { ok: false, result: { status: "forbidden" } };
  }

  if (provider !== "github") {
    const reason = await providerGate[provider](inst, spec, deps);
    if (reason) {
      const denied = await consumeActionTokens(actor.user.id, 1, deps.now());
      if (!denied.ok)
        return {
          ok: false,
          result: { status: "rate_limited", retryAfterS: denied.retryAfterS },
        };
      await session.record({
        params: { reason },
        status: "DENIED",
        error: `${UNAVAILABLE_PREFIX}${reason}`,
      });
      return { ok: false, result: { status: "unavailable", reason } };
    }
  }

  if (spec.purpose) {
    inst.permissions = await freshPermissions(inst, deps);
    const missing = missingPermissions(spec.purpose, inst.permissions);
    if (missing)
      return {
        ok: false,
        result: { status: "permission_not_granted", missing },
      };
  }

  const rate = await consumeActionTokens(
    actor.user.id,
    Math.max(1, spec.cost ?? 1),
    deps.now(),
  );
  if (!rate.ok)
    return {
      ok: false,
      result: { status: "rate_limited", retryAfterS: rate.retryAfterS },
    };

  return { ok: true, session };
}

export type Done<T> = {
  data: T;
  httpStatus?: number | null;
  requestId?: string | null;
};

export type RecordInput = {
  params: Record<string, unknown>;
  action?: AuditAction;
  target?: AuditTarget;
  batchId?: string | null;
  /** Defaults to the action's key; bulk children derive their own. */
  idempotencyKey?: string;
  status?: "PENDING" | "DENIED";
  /** Only for DENIED rows: why (e.g. "unavailable:<reason>"). */
  error?: string | null;
  /**
   * The identity that performs it when it is not the App (e.g.
   * "vercel:token:<hint>"); default: `GateSpec.actingAs`, else the App for
   * actions with a purpose.
   */
  actingAs?: string | null;
};

/** How a failed call is put into the audit row (status, message, request id). */
export type ErrorInfo = {
  status: number | null;
  message: string;
  requestId: string | null;
};

export type PerformOptions = {
  /** Default: GitHub's error shape (githubErrorInfo). */
  mapError?: (error: unknown) => ErrorInfo;
};

/** An authorised action: steps 6 to 9. */
export class ActionSession {
  constructor(
    readonly actor: ActionActor,
    readonly spec: GateSpec,
    readonly installation: ActionInstallation,
    readonly role: Role,
    private readonly provider: string,
    readonly deps: ActionDeps,
  ) {}

  /** Step 6: DIALOG needs the explicit confirmation, TYPED the exact name. */
  confirm(confirmation: Confirmation): boolean {
    if (confirmation.kind === "DIALOG") return confirmation.confirmed === true;
    return (
      confirmation.expected.length > 0 &&
      confirmation.typed.trim() === confirmation.expected
    );
  }

  /** Missing permissions of another purpose (e.g. the workflows merge token). */
  missing(purpose: TokenPurpose): string[] | null {
    return missingPermissions(purpose, this.installation.permissions);
  }

  /** The chain the rows go to: the installation's, or 0 (instance). */
  get auditInstallationId(): bigint {
    return this.spec.auditChain === "instance" ? 0n : this.installation.id;
  }

  /** Step 7: the hash-chained audit row (PENDING unless DENIED). */
  async record(input: RecordInput) {
    const target = input.target ?? this.spec.target;
    return appendAudit({
      installationId: this.auditInstallationId,
      actorUserId: this.actor.user.id,
      actorDisplay: this.actor.user.name || this.actor.user.email,
      actorRole: this.role,
      actorProvider: this.provider,
      actingAs:
        input.status === "DENIED"
          ? null
          : input.actingAs !== undefined
            ? input.actingAs
            : this.spec.actingAs !== undefined
              ? this.spec.actingAs
              : this.spec.purpose
                ? actingAs()
                : null,
      action: input.action ?? this.spec.action,
      repositoryId: target.repositoryId ?? null,
      repoFullName: target.repoFullName ?? null,
      targetType: target.type,
      targetId: target.id,
      batchId: input.batchId ?? null,
      params: input.params,
      confirmation: this.spec.confirmation,
      idempotencyKey: input.idempotencyKey ?? this.spec.idempotencyKey,
      status: input.status ?? "PENDING",
      ...(input.status === "DENIED" && input.error
        ? { error: input.error }
        : {}),
      ipHash: this.actor.ipHash ?? null,
      userAgent: this.actor.userAgent ?? null,
    });
  }

  /** An installation token for one purpose, narrowed to the target repos. */
  async api(
    purpose: TokenPurpose,
    repoIds?: ReadonlyArray<bigint>,
  ): Promise<GitHubApi> {
    return this.deps.clients.installation(
      this.installation.id,
      purpose,
      this.installation.permissions,
      repoIds,
    );
  }

  /** Runs `fn` for a recorded row and writes its final status (step 9). */
  async perform<T>(
    auditId: string,
    fn: () => Promise<Done<T>>,
    options: PerformOptions = {},
  ): Promise<Outcome<T>> {
    try {
      const done = await fn();
      await completeAudit(auditId, {
        status: "SUCCEEDED",
        httpStatus: done.httpStatus ?? null,
        githubRequestId: done.requestId ?? null,
      });
      return {
        status: "succeeded",
        auditId,
        replayed: false,
        data: done.data,
      };
    } catch (error) {
      const info: ErrorInfo =
        error instanceof PermissionNotGrantedError
          ? { status: null, message: error.message, requestId: null }
          : (options.mapError ?? githubErrorInfo)(error);
      await completeAudit(auditId, {
        status: "FAILED",
        httpStatus: info.status,
        githubRequestId: info.requestId,
        error: info.message,
      });
      if (info.status === null)
        console.error(
          "management action failed",
          redactError(info.message, 200),
        );
      return {
        status: "failed",
        auditId,
        replayed: false,
        httpStatus: info.status,
        message: info.message,
      };
    }
  }

  /** Step 8 and 9: mint the token, call GitHub, record the result. */
  async execute<T>(
    auditId: string,
    purpose: TokenPurpose,
    repoIds: ReadonlyArray<bigint> | undefined,
    fn: (api: GitHubApi) => Promise<Done<T>>,
  ): Promise<Outcome<T>> {
    return this.perform(auditId, async () =>
      fn(await this.api(purpose, repoIds)),
    );
  }

  /**
   * Vercel provider (design addendum §8.1): the read and write clients of
   * the installation's connection. The token is decrypted here, so this is
   * only called inside `executeVercel` (i.e. inside `perform`).
   */
  private async vercel(): Promise<{
    read: VercelReadApi;
    write: VercelWriteApi;
    token: string;
  }> {
    const cred = await vercelCredentialFor(this.installation.id);
    if (cred.kind !== "token") throw new Error("vercel_unavailable");
    const opts = {
      token: cred.token,
      teamId: cred.teamId,
      fetch: this.deps.vercelFetch,
      now: () => this.deps.now().getTime(),
    };
    return {
      read: createVercelClient(opts),
      write: createVercelWriteClient(opts),
      token: cred.token,
    };
  }

  /**
   * Step 8 and 9 for Vercel: decrypt the token, call Vercel, record the
   * result with Vercel's status, message and `x-vercel-id`, scrubbed of
   * the token. A rejected token (401, or 403 naming the token) also marks
   * the connection revoked (plus its finding), so the sync stops calling.
   * A 429 here does not pause the sync: write limits (deployments per day,
   * for example) are per action and can last hours, while the reads have
   * their own limits.
   */
  async executeVercel<T>(
    auditId: string,
    fn: (api: {
      read: VercelReadApi;
      write: VercelWriteApi;
    }) => Promise<Done<T>>,
  ): Promise<Outcome<T>> {
    let token: string | null = null;
    return this.perform(
      auditId,
      async () => {
        const api = await this.vercel();
        token = api.token;
        try {
          return await fn(api);
        } catch (error) {
          await noteVercelFailure(
            this.installation.id,
            error,
            this.deps.now(),
            api.token,
            { pause: false },
          );
          throw error;
        }
      },
      {
        mapError: (error) => {
          const info = vercelWriteErrorInfo(error);
          return { ...info, message: scrubKnown(info.message, [token], 500) };
        },
      },
    );
  }

  /**
   * Step 8 and 9 for Azure DevOps (design addendum M7 §7.1): resolve the
   * credential (a service principal's secret becomes a token here), call
   * Azure DevOps, record the result with its status, message and activity
   * id (stored as the request id), scrubbed of the credential and the
   * organisation name. A rejected credential also revokes the connection;
   * a rate stop on a write does not pause the sync.
   */
  async executeAzure<T>(
    auditId: string,
    fn: (api: {
      read: AzureReadApi;
      write: AzureWriteApi;
      org: string;
      secrets: string[];
    }) => Promise<Done<T>>,
  ): Promise<Outcome<T>> {
    let secrets: string[] = [];
    return this.perform(
      auditId,
      async () => {
        const cred = await azureCredentialFor(this.installation.id, {
          fetch: this.deps.azureFetch,
        }).catch(async (error: unknown) => {
          await noteAzureFailure(
            this.installation.id,
            error,
            this.deps.now(),
            [],
            { pause: false },
          );
          throw error;
        });
        if (cred.kind !== "token") throw new Error("azure_unavailable");
        secrets = [...cred.secrets, cred.org];
        const opts = {
          org: cred.org,
          auth: cred.auth,
          fetch: this.deps.azureFetch,
          now: () => this.deps.now().getTime(),
        };
        const api = {
          read: createAzureClient(opts),
          write: createAzureWriteClient(opts),
          org: cred.org,
          secrets,
        };
        try {
          return await fn(api);
        } catch (error) {
          await noteAzureFailure(
            this.installation.id,
            error,
            this.deps.now(),
            secrets,
            { pause: false },
          );
          throw error;
        }
      },
      {
        mapError: (error) => {
          const info = azureErrorInfo(error);
          return { ...info, message: scrubKnown(info.message, secrets, 500) };
        },
      },
    );
  }

  /** Writes the final status of a row whose work was done outside `perform` (bulk parents). */
  async finish(auditId: string, completion: AuditCompletion): Promise<void> {
    await completeAudit(auditId, completion);
  }

  revalidate(): void {
    try {
      this.deps.revalidate(this.installation.id);
    } catch {
      // Outside a request (tests, scripts) there is no cache to revalidate.
    }
  }
}

/** Shorthand for the common "record, then execute" sequence. */
export async function recordAndExecute<T>(
  session: ActionSession,
  record: RecordInput,
  purpose: TokenPurpose,
  repoIds: ReadonlyArray<bigint> | undefined,
  fn: (api: GitHubApi, auditId: string) => Promise<Done<T>>,
): Promise<ActionResult<T>> {
  const row = await session.record(record);
  if (!row.created) {
    const replay = await replayOf(
      session.actor,
      session.auditInstallationId,
      record.idempotencyKey ?? session.spec.idempotencyKey,
    );
    return replay?.result ?? { status: "conflict" };
  }
  const outcome = await session.execute(row.id, purpose, repoIds, (api) =>
    fn(api, row.id),
  );
  session.revalidate();
  return outcome;
}
