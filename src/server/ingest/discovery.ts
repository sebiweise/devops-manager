import "server-only";
import { isAllowedAccount } from "@/server/authz/config";
import { db } from "@/server/db";
import { appOctokit, installationOctokit } from "@/server/github/app";
import {
  applyInstallation,
  markInstallationDeleted,
  syncRepositorySet,
} from "./inventory";
import type { GhInstallation, GhRepository } from "./types";

/**
 * Installation discovery with the App JWT (design §3.5 "Installation
 * onboarding"). GitHub is the source of truth: a client-supplied
 * `installation_id` is only accepted after `GET /app/installations/{id}`
 * confirms it belongs to this App and to an allowed account.
 */

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404
  );
}

/** GitHub's view of one installation of this App, or null if it is not ours. */
export async function fetchAppInstallation(
  installationId: bigint | number,
): Promise<GhInstallation | null> {
  try {
    const { data } = await appOctokit().request(
      "GET /app/installations/{installation_id}",
      {
        installation_id: Number(installationId),
      },
    );
    return data as unknown as GhInstallation;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Live repository list of an installation, read with a metadata-only token. */
export async function fetchInstallationRepositories(
  installationId: bigint,
  granted: Record<string, unknown>,
): Promise<GhRepository[]> {
  const octokit = await installationOctokit(
    installationId,
    "sync.inventory",
    granted,
  );
  const repos = await octokit.paginate("GET /installation/repositories", {
    per_page: 100,
  });
  return repos as unknown as GhRepository[];
}

/**
 * Verifies an installation id with GitHub, stores it and its repositories.
 * Returns the stored installation's account login, or null when the id is
 * unknown to this App or belongs to an account outside ALLOWED_ACCOUNTS.
 */
export async function verifyAndStoreInstallation(
  installationId: bigint | number,
): Promise<string | null> {
  const gh = await fetchAppInstallation(installationId);
  if (!gh?.account || !isAllowedAccount(gh.account.login)) return null;
  await applyInstallation(gh);
  if (!gh.suspended_at) {
    const repos = await fetchInstallationRepositories(
      BigInt(gh.id),
      gh.permissions,
    );
    await syncRepositorySet(BigInt(gh.id), repos);
  }
  return gh.account.login;
}

export type DiscoveryResult = {
  installations: number;
  ignored: number;
  removed: number;
  errors: string[];
};

/**
 * Lists every installation of the App, stores the allowed ones with their
 * repositories and marks local installations that GitHub no longer lists as
 * deleted.
 */
export async function discoverInstallations(): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    installations: 0,
    ignored: 0,
    removed: 0,
    errors: [],
  };
  const all = (await appOctokit().paginate("GET /app/installations", {
    per_page: 100,
  })) as unknown as GhInstallation[];

  const seen = new Set<bigint>();
  for (const gh of all) {
    if (!gh.account || !isAllowedAccount(gh.account.login)) {
      result.ignored++;
      continue;
    }
    const id = BigInt(gh.id);
    seen.add(id);
    try {
      await applyInstallation(gh);
      result.installations++;
      if (!gh.suspended_at) {
        await syncRepositorySet(
          id,
          await fetchInstallationRepositories(id, gh.permissions),
        );
      }
    } catch (error) {
      result.errors.push(
        `installation ${gh.id}: ${error instanceof Error ? error.message : "failed"}`,
      );
    }
  }

  const stale = await db.installation.findMany({
    where: { deletedAt: null, id: { notIn: [...seen] } },
    select: { id: true },
  });
  for (const { id } of stale) {
    await markInstallationDeleted(id);
    result.removed++;
  }
  return result;
}
