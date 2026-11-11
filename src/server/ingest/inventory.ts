import "server-only";
import { isAllowedAccount } from "@/server/authz/config";
import { db } from "@/server/db";
import { forgetInstallationTokens } from "@/server/github/app";
import type {
  AppAuthorizationEvent,
  GhInstallation,
  GhRepository,
  InstallationEvent,
  InstallationRepositoriesEvent,
  RepositoryEvent,
} from "./types";

/**
 * Fold functions for the inventory: installations and repositories (design
 * §5.2). All of them are idempotent, so webhooks, the onboarding check and
 * reconcile can call them in any order and any number of times.
 */

const PURGE_AFTER_DAYS = 30;

export function installationFields(gh: GhInstallation) {
  if (!gh.account) throw new Error(`Installation ${gh.id} has no account`);
  return {
    accountId: BigInt(gh.account.id),
    accountLogin: gh.account.login,
    accountType:
      gh.account.type === "Organization"
        ? ("ORGANIZATION" as const)
        : ("USER" as const),
    repositorySelection:
      gh.repository_selection === "all"
        ? ("ALL" as const)
        : ("SELECTED" as const),
    permissions: Object.fromEntries(
      Object.entries(gh.permissions ?? {}).filter(
        ([, v]) => typeof v === "string",
      ),
    ),
    events: gh.events ?? [],
    suspendedAt: gh.suspended_at ? new Date(gh.suspended_at) : null,
    permissionsCheckedAt: new Date(),
  };
}

export function repositoryFields(installationId: bigint, repo: GhRepository) {
  const [ownerFromFullName = "", nameFromFullName = repo.name] =
    repo.full_name.split("/");
  return {
    installationId,
    ownerLogin: repo.owner?.login ?? ownerFromFullName,
    name: repo.name ?? nameFromFullName,
    fullName: repo.full_name,
    private: repo.private,
    ...(repo.archived !== undefined ? { archived: repo.archived } : {}),
    ...(repo.default_branch ? { defaultBranch: repo.default_branch } : {}),
    removedAt: null,
  };
}

/**
 * Upserts an installation from GitHub's view of it. Installations of accounts
 * outside ALLOWED_ACCOUNTS are never stored. Returns false when ignored.
 */
export async function applyInstallation(gh: GhInstallation): Promise<boolean> {
  if (!gh.account || !isAllowedAccount(gh.account.login)) return false;
  const fields = installationFields(gh);
  const id = BigInt(gh.id);

  await db.$transaction(async (tx) => {
    // A reinstall creates a new installation id for the same account. The old,
    // uninstalled row would collide on accountLogin; its data is already hidden.
    await tx.installation.deleteMany({
      where: {
        accountLogin: fields.accountLogin,
        id: { not: id },
        deletedAt: { not: null },
      },
    });
    await tx.installation.upsert({
      where: { id },
      create: { id, ...fields },
      update: { ...fields, deletedAt: null, purgeAfter: null },
    });
  });
  forgetInstallationTokens(id);
  return true;
}

export async function markInstallationDeleted(installationId: bigint) {
  const now = new Date();
  await db.installation.updateMany({
    where: { id: installationId },
    data: {
      deletedAt: now,
      purgeAfter: new Date(now.getTime() + PURGE_AFTER_DAYS * 86_400_000),
    },
  });
  forgetInstallationTokens(installationId);
}

export async function upsertRepositories(
  installationId: bigint,
  repos: GhRepository[],
) {
  if (repos.length === 0) return;
  await db.$transaction(async (tx) => {
    for (const repo of repos) {
      const id = BigInt(repo.id);
      const fields = repositoryFields(installationId, repo);
      // A repo moved between two installations of this instance follows its
      // new installation; fullName is unique per installation.
      await tx.repository.deleteMany({
        where: { installationId, fullName: fields.fullName, id: { not: id } },
      });
      await tx.repository.upsert({
        where: { id },
        create: { id, ...fields },
        update: fields,
      });
    }
    await tx.syncState.createMany({
      data: repos.map((r) => ({ repositoryId: BigInt(r.id), installationId })),
      skipDuplicates: true,
    });
  });
}

export async function removeRepositories(
  installationId: bigint,
  repoIds: number[],
) {
  if (repoIds.length === 0) return;
  await db.repository.updateMany({
    where: { installationId, id: { in: repoIds.map((id) => BigInt(id)) } },
    data: { removedAt: new Date() },
  });
}

/**
 * Replaces the repository set of an installation with GitHub's current list
 * (discovery and reconcile). Repos not in the list are marked removed.
 */
export async function syncRepositorySet(
  installationId: bigint,
  repos: GhRepository[],
) {
  await upsertRepositories(installationId, repos);
  await db.repository.updateMany({
    where: {
      installationId,
      removedAt: null,
      id: { notIn: repos.map((r) => BigInt(r.id)) },
    },
    data: { removedAt: new Date() },
  });
}

export async function handleInstallationEvent(event: InstallationEvent) {
  const id = BigInt(event.installation.id);
  switch (event.action) {
    case "deleted":
      await markInstallationDeleted(id);
      return;
    case "created":
    case "new_permissions_accepted":
    case "suspend":
    case "unsuspend": {
      const applied = await applyInstallation(event.installation);
      if (applied && event.action === "created" && event.repositories) {
        await upsertRepositories(id, event.repositories);
      }
      return;
    }
    default:
      return;
  }
}

export async function handleInstallationRepositoriesEvent(
  event: InstallationRepositoriesEvent,
) {
  const id = BigInt(event.installation.id);
  const applied = await applyInstallation({
    ...event.installation,
    repository_selection:
      event.repository_selection ?? event.installation.repository_selection,
  });
  if (!applied) return;
  await upsertRepositories(id, event.repositories_added ?? []);
  await removeRepositories(
    id,
    (event.repositories_removed ?? []).map((r) => r.id),
  );
}

export async function handleRepositoryEvent(
  installationId: bigint,
  event: RepositoryEvent,
) {
  const repo = event.repository;
  switch (event.action) {
    case "deleted":
      await removeRepositories(installationId, [repo.id]);
      return;
    case "transferred": {
      // After a transfer the repo belongs to another account. It stays only if
      // that account is this installation's account.
      const inst = await db.installation.findUnique({
        where: { id: installationId },
      });
      if (
        !inst ||
        inst.accountLogin.toLowerCase() !== repo.owner.login.toLowerCase()
      ) {
        await removeRepositories(installationId, [repo.id]);
        return;
      }
      await upsertRepositories(installationId, [repo]);
      return;
    }
    default:
      // created, renamed, edited, archived, unarchived, publicized, privatized
      await upsertRepositories(installationId, [repo]);
  }
}

/**
 * `github_app_authorization.revoked`: a GitHub user revoked the App's user
 * authorisation. The GitHub login link of that user is deleted, and so are the
 * user's sessions (sessions do not record their provider, so all of them go).
 */
export async function handleAppAuthorizationEvent(
  event: AppAuthorizationEvent,
) {
  if (event.action !== "revoked") return;
  const accounts = await db.account.findMany({
    where: { providerId: "github", accountId: String(event.sender.id) },
    select: { id: true, userId: true },
  });
  if (accounts.length === 0) return;
  await db.$transaction([
    db.account.deleteMany({ where: { id: { in: accounts.map((a) => a.id) } } }),
    db.session.deleteMany({
      where: { userId: { in: accounts.map((a) => a.userId) } },
    }),
  ]);
}
