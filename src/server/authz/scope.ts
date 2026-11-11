import "server-only";
import { db } from "@/server/db";
import {
  isAllowedAccount,
  roleRulesFromEnv,
  signInGateFromEnv,
} from "./config";
import { resolveRole, type Role } from "./roles";

/**
 * What a user may see (design §3.6). In v1 every user with a role sees all
 * active installations of the instance; the data layer already filters by
 * `installationIds`, so per-user scoping can be added later without touching
 * the data functions.
 */
export type TenantScope = {
  userId: string;
  role: Role;
  installationIds: bigint[];
};

/** Effective role of a stored user, re-resolved against the current env. */
export async function currentRole(userId: string): Promise<Role | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      emailVerified: true,
      oidcGroups: true,
      roleOverride: true,
      disabledAt: true,
    },
  });
  if (!user) return null;
  const gate = signInGateFromEnv();
  return resolveRole(
    {
      email: user.email,
      emailVerified: gate.requireVerifiedEmail ? user.emailVerified : true,
      groups: user.oidcGroups,
    },
    { roleOverride: user.roleOverride, disabledAt: user.disabledAt },
    roleRulesFromEnv(),
  );
}

/** Ids of installations that are active and belong to an allowed account. */
export async function activeInstallationIds(): Promise<bigint[]> {
  const rows = await db.installation.findMany({
    where: { deletedAt: null, suspendedAt: null },
    select: { id: true, accountLogin: true },
  });
  return rows.filter((r) => isAllowedAccount(r.accountLogin)).map((r) => r.id);
}

export async function getScope(userId: string): Promise<TenantScope | null> {
  const role = await currentRole(userId);
  if (!role) return null;
  return { userId, role, installationIds: await activeInstallationIds() };
}
