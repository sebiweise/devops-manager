import "server-only";
import type { TenantScope } from "@/server/authz/scope";
import { fetchInstallationRepositories } from "@/server/ingest/discovery";
import { syncRepositorySet } from "@/server/ingest/inventory";
import {
  inScope,
  listInstallations,
  listRepositories,
  NotFoundError,
  type InstallationRow,
} from "./installations";

export type RepoDto = {
  id: string;
  fullName: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
};

export type InstallationRepos = {
  installation: {
    id: string;
    accountLogin: string;
    accountType: "USER" | "ORGANIZATION";
  };
  source: "live" | "stored";
  repos: RepoDto[];
};

/**
 * The repository list of one visible installation, read live from GitHub with
 * a metadata-only installation token. The result also refreshes the stored
 * inventory. When GitHub is unreachable the stored list is shown instead.
 */
export async function liveRepositories(
  scope: TenantScope,
  installation: InstallationRow,
): Promise<InstallationRepos> {
  if (!inScope(scope, installation.id)) throw new NotFoundError();
  const header = {
    id: String(installation.id),
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
  };
  try {
    const repos = await fetchInstallationRepositories(
      installation.id,
      (installation.permissions ?? {}) as Record<string, unknown>,
    );
    await syncRepositorySet(installation.id, repos);
    return {
      installation: header,
      source: "live",
      repos: repos
        .map((r) => ({
          id: String(r.id),
          fullName: r.full_name,
          private: r.private,
          archived: r.archived ?? false,
          defaultBranch: r.default_branch ?? "main",
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    };
  } catch (error) {
    console.warn("live repository list failed, using stored list", {
      installationId: header.id,
      error: error instanceof Error ? error.message : "unknown",
    });
    const stored = await listRepositories(scope, installation.id);
    return {
      installation: header,
      source: "stored",
      repos: stored.map((r) => ({
        id: String(r.id),
        fullName: r.fullName,
        private: r.private,
        archived: r.archived,
        defaultBranch: r.defaultBranch,
      })),
    };
  }
}

/** Live repository lists of all visible installations, fetched in parallel. */
export async function dashboardRepositories(
  scope: TenantScope,
): Promise<InstallationRepos[]> {
  const installations = await listInstallations(scope);
  return Promise.all(
    installations.map((inst) => liveRepositories(scope, inst)),
  );
}
