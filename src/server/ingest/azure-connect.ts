import "server-only";
import {
  AzureError,
  createAzureClient,
  normalizeOrg,
  type AzureProjectInfo,
  type AzureReadApi,
  type Fetch,
} from "@/server/azure/client";
import { EntraError } from "@/server/azure/entra";
import { db } from "@/server/db";
import {
  authOf,
  isAllowedAzureOrg,
  secretHintOf,
  type EnvAzureCredential,
  type PlainAzureCredential,
} from "./azure-credential";

/**
 * Validation of an Azure DevOps credential before anything is stored
 * (design addendum M7 §3 step 2), shared by Connect, Rotate and the env
 * shortcut:
 *
 * 1. The organisation: `^[A-Za-z0-9][A-Za-z0-9-]{0,49}$`, host fixed to
 *    dev.azure.com, `<org>.visualstudio.com` normalised; ALLOWED_AZURE_ORGS.
 * 2. A service principal's secret is exchanged for a token (Entra).
 * 3. `GET /_apis/connectionData` gives the organisation id (the instance
 *    id; verify). When the route is not readable the id falls back to
 *    `name:<org>` (documented in docs/AZURE-DEVOPS.md). The identity is
 *    used for nothing else and not stored.
 * 4. Read-scope probes: projects (Project and Team: Read), agent pools
 *    (Agent Pools: Read) and builds of one project (Build: Read). A missing
 *    read scope is a specific error; execute and service hook scopes are
 *    probed later (the management toggle, hook creation).
 * 5. The suggested project selection: projects with a GitHub definition
 *    pointing at a repository of this installation (at most 20 probed).
 *
 * Only GETs (and the Entra token request). Errors are codes for the UI;
 * no Azure DevOps message is echoed.
 */

export type AzureCheckError =
  | "invalid_org"
  | "org_not_allowed"
  | "invalid_token"
  | "invalid_secret"
  | "entra_unavailable"
  | "scope_missing_projects"
  | "scope_missing_pools"
  | "scope_missing_build"
  | "rate_limited"
  | "azure_unavailable";

export type AzureScopes = {
  projects: "ok" | "missing" | "unknown";
  pools: "ok" | "missing" | "unknown";
  builds: "ok" | "missing" | "unknown";
  execute: "ok" | "missing" | "unknown";
  hooks: "ok" | "missing" | "unknown";
};

export type AzureCheck =
  | {
      ok: true;
      org: string;
      orgId: string;
      scopes: AzureScopes;
      projects: Array<AzureProjectInfo & { suggested: boolean }>;
      hint: string;
    }
  | { ok: false; error: AzureCheckError };

const PROBE_PROJECTS = 20;

function mapError(error: unknown): AzureCheckError {
  if (error instanceof EntraError)
    return error.revoked ? "invalid_secret" : "entra_unavailable";
  if (error instanceof AzureError) {
    if (error.revoked) return "invalid_token";
    if (error.rateLimited) return "rate_limited";
  }
  return "azure_unavailable";
}

/** The organisation id from connectionData, or the name fallback. */
async function orgIdOf(api: AzureReadApi, org: string): Promise<string> {
  try {
    const { orgId } = await api.connectionData();
    if (orgId) return orgId;
  } catch (error) {
    if (
      !(error instanceof AzureError) ||
      error.revoked ||
      error.rateLimited ||
      ![
        "not_found",
        "unexpected_response",
        "bad_request",
        "forbidden",
      ].includes(error.code)
    )
      throw error;
  }
  return `name:${org.toLowerCase()}`;
}

export async function checkAzureCredential(
  orgInput: string,
  credential: PlainAzureCredential,
  opts: {
    fetch?: Fetch;
    now?: Date;
    /** Repositories of the installation ("owner/name", lowercase) for the suggested selection. */
    repoFullNames?: ReadonlySet<string>;
  } = {},
): Promise<AzureCheck> {
  const org = normalizeOrg(orgInput);
  if (!org) return { ok: false, error: "invalid_org" };
  if (!isAllowedAzureOrg(org)) return { ok: false, error: "org_not_allowed" };
  const hint = secretHintOf(
    credential.kind === "pat" ? credential.pat : credential.clientSecret,
  );
  let api: AzureReadApi;
  try {
    const { auth } = await authOf(credential, { fetch: opts.fetch });
    api = createAzureClient({ org, auth, fetch: opts.fetch });
  } catch (error) {
    return { ok: false, error: mapError(error) };
  }
  let orgId: string;
  try {
    orgId = await orgIdOf(api, org);
  } catch (error) {
    return { ok: false, error: mapError(error) };
  }
  const scopes: AzureScopes = {
    projects: "unknown",
    pools: "unknown",
    builds: "unknown",
    execute: "unknown",
    hooks: "unknown",
  };
  const projects: AzureProjectInfo[] = [];
  try {
    let continuation: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r = await api.listProjects(continuation);
      projects.push(...r.projects);
      if (!r.continuation || r.projects.length === 0) break;
      continuation = r.continuation;
    }
    scopes.projects = "ok";
  } catch (error) {
    if (error instanceof AzureError && error.code === "forbidden")
      return { ok: false, error: "scope_missing_projects" };
    return { ok: false, error: mapError(error) };
  }
  try {
    await api.listPools();
    scopes.pools = "ok";
  } catch (error) {
    if (error instanceof AzureError && error.code === "forbidden")
      return { ok: false, error: "scope_missing_pools" };
    return { ok: false, error: mapError(error) };
  }
  const suggested = new Set<string>();
  for (const p of projects.slice(0, PROBE_PROJECTS)) {
    try {
      const defs = await api.listDefinitions(p.id);
      scopes.builds = "ok";
      if (
        opts.repoFullNames &&
        defs.definitions.some(
          (d) =>
            d.repoFullName &&
            opts.repoFullNames!.has(d.repoFullName.toLowerCase()),
        )
      )
        suggested.add(p.id);
    } catch (error) {
      if (error instanceof AzureError && error.code === "forbidden")
        return { ok: false, error: "scope_missing_build" };
      if (error instanceof AzureError && error.code === "not_found") continue;
      return { ok: false, error: mapError(error) };
    }
  }
  if (projects.length > 0 && scopes.builds === "unknown")
    scopes.builds = "missing";
  return {
    ok: true,
    org,
    orgId,
    scopes,
    projects: projects.map((p) => ({ ...p, suggested: suggested.has(p.id) })),
    hint,
  };
}

/** Repositories of an installation as "owner/name" (lowercase), active and not ignored. */
export async function installationRepoNames(
  installationId: bigint,
): Promise<Set<string>> {
  const repos = await db.repository.findMany({
    where: { installationId, removedAt: null, ignoredAt: null },
    select: { fullName: true },
  });
  return new Set(repos.map((r) => r.fullName.toLowerCase()));
}

/** Stores the project list of a check (selection: the suggested ones unless already chosen). */
export async function storeProjects(
  installationId: bigint,
  projects: ReadonlyArray<AzureProjectInfo & { suggested?: boolean }>,
  opts: { applySuggestion: boolean },
): Promise<void> {
  const seen: string[] = [];
  for (const p of projects) {
    seen.push(p.id);
    await db.azureDevOpsProject.upsert({
      where: { installationId_id: { installationId, id: p.id } },
      create: {
        installationId,
        id: p.id,
        name: p.name,
        visibility: p.visibility,
        selected: opts.applySuggestion ? p.suggested === true : false,
      },
      update: { name: p.name, visibility: p.visibility, removedAt: null },
    });
  }
  await db.azureDevOpsProject.updateMany({
    where: { installationId, removedAt: null, id: { notIn: seen } },
    data: { removedAt: new Date(), selected: false },
  });
}

const envAttempts = new Map<string, number>();
const ENV_RETRY_MS = 10 * 60_000;

/**
 * The env shortcut: the AZURE_DEVOPS_* credential belongs to the
 * installation of AZURE_DEVOPS_ACCOUNT. Without a connection row it is
 * validated (at most every 10 minutes per process) and a row with
 * `authKind = ENV` and no stored secret is created. A connection an admin
 * made in the UI is left alone.
 */
export async function ensureAzureEnvConnection(
  installationId: bigint,
  envCred: EnvAzureCredential,
  fetchImpl: Fetch | undefined,
  now: Date,
): Promise<"created" | "exists" | "not_applicable" | "refused"> {
  const inst = await db.installation.findUnique({
    where: { id: installationId },
    select: { accountLogin: true, azure: { select: { installationId: true } } },
  });
  if (
    !inst ||
    inst.accountLogin.toLowerCase() !== envCred.accountLogin.toLowerCase()
  )
    return "not_applicable";
  if (inst.azure) return "exists";
  const key = String(installationId);
  const last = envAttempts.get(key);
  if (last && now.getTime() - last < ENV_RETRY_MS) return "refused";
  envAttempts.set(key, now.getTime());
  const check = await checkAzureCredential(envCred.org, envCred, {
    fetch: fetchImpl,
    now,
    repoFullNames: await installationRepoNames(installationId),
  });
  if (!check.ok) {
    console.warn("Azure DevOps env credential refused:", check.error);
    return "refused";
  }
  const taken = await db.azureDevOpsConnection.findUnique({
    where: { orgId: check.orgId },
    select: { installationId: true },
  });
  if (taken) {
    console.warn(
      "Azure DevOps env credential refused: organisation already connected elsewhere",
    );
    return "refused";
  }
  await db.azureDevOpsConnection.create({
    data: {
      installationId,
      orgId: check.orgId,
      orgName: check.org,
      authKind: "ENV",
      accessToken: null,
      tokenHint: check.hint,
      scopes: check.scopes,
      createdByUserId: "env",
    },
  });
  await storeProjects(installationId, check.projects, {
    applySuggestion: true,
  });
  envAttempts.delete(key);
  return "created";
}

/** Tests only. */
export function resetAzureEnvAttempts(): void {
  envAttempts.clear();
}
