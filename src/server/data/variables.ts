import "server-only";
import { LRUCache } from "lru-cache";
import { mapLimit } from "@/lib/concurrency";
import type { TenantScope } from "@/server/authz/scope";
import { hasRole } from "@/server/authz/roles";
import {
  listOrgVariableRepos,
  listOrgVariables,
  listRepoVariables,
  type OrgVisibility,
} from "@/server/github/rest";
import { missingOf } from "@/server/github/purposes";
import type { GitHubClients } from "@/server/ingest/github-client";
import { githubClients } from "@/server/ingest/triggers";
import type { VariablePreset } from "@/server/management/variable-rules";
import {
  findInstallationAccount,
  listRepoTargets,
  variablePresets,
} from "./management";

/**
 * The variables matrix (design §7 /variables): repository variables of every
 * active repo, plus the organisation's variables for org installations with
 * Organization `Variables` granted. Read live with a `read.variables` token
 * narrowed to the installation's repos (`read.org_variables` for the org
 * part) and cached in memory for 60 s; management writes drop the cache.
 *
 * Values are visible to every role unless the installation's redaction
 * setting is on: then viewers and operators get them masked (null with
 * `masked: true`), and only admins see them.
 */

export type VariableCell = {
  value: string | null;
  masked: boolean;
  updatedAt: string | null;
};

export type RepoVariables = {
  repositoryId: string;
  fullName: string;
  archived: boolean;
  status: "ok" | "unavailable";
  variables: Record<string, VariableCell>;
};

export type OrgVariableRow = VariableCell & {
  name: string;
  visibility: OrgVisibility;
  /** Repo ids for `selected` visibility (within this installation). */
  selectedRepositoryIds: string[] | null;
};

export type OrgVariables =
  | { status: "ok"; variables: OrgVariableRow[] }
  | { status: "no_permission" | "unavailable" };

export type VariableMatrix =
  | {
      status: "ok";
      /** True when values are masked for this viewer. */
      masked: boolean;
      names: string[];
      repos: RepoVariables[];
      /** Null for personal-account installations. */
      org: OrgVariables | null;
      presets: VariablePreset[];
      /** More active repos than the matrix shows. */
      truncated: boolean;
    }
  | { status: "no_permission"; missing: string[]; presets: VariablePreset[] };

const MAX_REPOS = 200;
const CONCURRENCY = 4;
const TTL_MS = 60_000;

type RawRepo = {
  repositoryId: string;
  fullName: string;
  archived: boolean;
  status: "ok" | "unavailable";
  variables: Array<{ name: string; value: string; updatedAt: string | null }>;
};

type RawOrg =
  | {
      status: "ok";
      variables: Array<{
        name: string;
        value: string;
        visibility: OrgVisibility;
        updatedAt: string | null;
        selectedRepositoryIds: string[] | null;
      }>;
    }
  | { status: "no_permission" | "unavailable" };

const cache = new LRUCache<
  string,
  Promise<{ repos: RawRepo[]; org: RawOrg | null; truncated: boolean }>
>({ max: 200, ttl: TTL_MS });

/** Drops the cached matrix of an installation (after a write). */
export function forgetVariables(installationId: bigint): void {
  cache.delete(String(installationId));
}

/** Empties the cache (tests). */
export function resetVariablesCache(): void {
  cache.clear();
}

export async function listVariableMatrix(
  scope: TenantScope,
  installationId: bigint,
  clients: GitHubClients = githubClients,
): Promise<VariableMatrix> {
  const inst = await findInstallationAccount(scope, installationId);
  const presets = variablePresets();
  const missing = missingOf("read.variables", inst.permissions);
  if (missing) return { status: "no_permission", missing, presets };
  const repos = await listRepoTargets(scope, installationId);

  const key = String(installationId);
  let pending = cache.get(key);
  if (!pending) {
    pending = loadMatrix(inst, repos, clients);
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  const raw = await pending;
  const masked = inst.redactVariableValues && !hasRole(scope.role, "ADMIN");
  const cell = (value: string, updatedAt: string | null): VariableCell => ({
    value: masked ? null : value,
    masked,
    updatedAt,
  });
  const names = new Set<string>();
  const out: RepoVariables[] = raw.repos.map((r) => {
    const variables: Record<string, VariableCell> = {};
    for (const v of r.variables) {
      names.add(v.name);
      variables[v.name] = cell(v.value, v.updatedAt);
    }
    return { ...r, variables };
  });
  const org: OrgVariables | null =
    raw.org === null
      ? null
      : raw.org.status === "ok"
        ? {
            status: "ok",
            variables: raw.org.variables.map((v) => ({
              name: v.name,
              visibility: v.visibility,
              selectedRepositoryIds: v.selectedRepositoryIds,
              ...cell(v.value, v.updatedAt),
            })),
          }
        : raw.org;
  return {
    status: "ok",
    masked,
    names: [...names].sort(),
    repos: out,
    org,
    presets,
    truncated: raw.truncated,
  };
}

async function loadMatrix(
  inst: Awaited<ReturnType<typeof findInstallationAccount>>,
  allRepos: Awaited<ReturnType<typeof listRepoTargets>>,
  clients: GitHubClients,
): Promise<{ repos: RawRepo[]; org: RawOrg | null; truncated: boolean }> {
  const repos = allRepos.slice(0, MAX_REPOS);
  let rows: RawRepo[] = [];
  if (repos.length > 0) {
    const api = await clients.installation(
      inst.id,
      "read.variables",
      inst.permissions,
      repos.map((r) => r.id),
    );
    rows = await mapLimit(repos, CONCURRENCY, async (repo) => {
      const base = {
        repositoryId: String(repo.id),
        fullName: repo.fullName,
        archived: repo.archived,
      };
      try {
        const vars = await listRepoVariables(api, repo);
        return {
          ...base,
          status: "ok" as const,
          variables: vars.map((v) => ({
            name: v.name,
            value: v.value,
            updatedAt: v.updated_at ?? null,
          })),
        };
      } catch {
        return { ...base, status: "unavailable" as const, variables: [] };
      }
    });
  }

  let org: RawOrg | null = null;
  if (inst.accountType === "ORGANIZATION") {
    if (missingOf("read.org_variables", inst.permissions)) {
      org = { status: "no_permission" };
    } else {
      try {
        const api = await clients.installation(
          inst.id,
          "read.org_variables",
          inst.permissions,
        );
        const known = new Set(allRepos.map((r) => String(r.id)));
        const vars = await listOrgVariables(api, inst.accountLogin);
        org = {
          status: "ok",
          variables: await mapLimit(vars, CONCURRENCY, async (v) => ({
            name: v.name,
            value: v.value,
            visibility: v.visibility,
            updatedAt: v.updated_at ?? null,
            selectedRepositoryIds:
              v.visibility === "selected"
                ? (await listOrgVariableRepos(api, inst.accountLogin, v.name))
                    .map(String)
                    .filter((id) => known.has(id))
                : null,
          })),
        };
      } catch {
        org = { status: "unavailable" };
      }
    }
  }
  return { repos: rows, org, truncated: allRepos.length > repos.length };
}
