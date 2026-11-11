/**
 * App-level roles (design §3.6).
 *
 * `VIEWER < OPERATOR < ADMIN`. A role is resolved from comma-separated env
 * allowlists of emails and OIDC groups; the highest match wins. Email rules
 * apply only to verified emails, group rules only to the OIDC provider's
 * groups claim. A DB override can raise the env role but never lower it: env
 * assignments are a floor and break-glass access.
 *
 * This module is pure (no env, no DB) so the full matrix is unit-tested.
 */

export const ROLES = ["VIEWER", "OPERATOR", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { VIEWER: 1, OPERATOR: 2, ADMIN: 3 };

export function roleRank(role: Role | null | undefined): number {
  return role ? RANK[role] : 0;
}

/** True when `role` is at least `required`. */
export function hasRole(
  role: Role | null | undefined,
  required: Role,
): boolean {
  return roleRank(role) >= RANK[required];
}

export function maxRole(...roles: Array<Role | null | undefined>): Role | null {
  let best: Role | null = null;
  for (const role of roles)
    if (roleRank(role) > roleRank(best)) best = role ?? null;
  return best;
}

export type RoleRules = {
  adminEmails: string[];
  adminGroups: string[];
  operatorEmails: string[];
  operatorGroups: string[];
  viewerEmails: string[];
  viewerGroups: string[];
  defaultRole: "none" | "viewer";
};

export type Identity = {
  email: string | null | undefined;
  emailVerified: boolean;
  /** OIDC groups claim; empty for GitHub sign-ins. */
  groups: readonly string[];
};

const norm = (s: string) => s.trim().toLowerCase();

function matches(list: readonly string[], values: readonly string[]): boolean {
  if (list.length === 0 || values.length === 0) return false;
  const set = new Set(list.map(norm));
  return values.some((v) => set.has(norm(v)));
}

/**
 * Role from the env allowlists alone, or null when nothing matches and
 * `DEFAULT_ROLE=none`.
 */
export function resolveEnvRole(
  identity: Identity,
  rules: RoleRules,
): Role | null {
  const emails =
    identity.emailVerified && identity.email ? [identity.email] : [];
  const groups = identity.groups;

  if (matches(rules.adminEmails, emails) || matches(rules.adminGroups, groups))
    return "ADMIN";
  if (
    matches(rules.operatorEmails, emails) ||
    matches(rules.operatorGroups, groups)
  )
    return "OPERATOR";
  if (
    matches(rules.viewerEmails, emails) ||
    matches(rules.viewerGroups, groups)
  )
    return "VIEWER";
  return rules.defaultRole === "viewer" ? "VIEWER" : null;
}

/** True when the env allowlists themselves (not DEFAULT_ROLE) assign a role. */
export function isEnvAssigned(identity: Identity, rules: RoleRules): boolean {
  return resolveEnvRole(identity, { ...rules, defaultRole: "none" }) !== null;
}

export type StoredUserState = {
  roleOverride?: Role | null;
  disabledAt?: Date | null;
};

/**
 * Effective role: `max(envRole, roleOverride)`. A disabled user has no role,
 * unless the env allowlists assign one (env roles cannot be disabled from the
 * UI, so the last admin cannot be locked out).
 */
export function resolveRole(
  identity: Identity,
  stored: StoredUserState,
  rules: RoleRules,
): Role | null {
  const envRole = resolveEnvRole(identity, rules);
  if (stored.disabledAt && !isEnvAssigned(identity, rules)) return null;
  return maxRole(envRole, stored.roleOverride ?? null);
}

export type SignInGateConfig = {
  allowedGroups: string[];
  requireVerifiedEmail: boolean;
};

export type SignInDecision =
  | { ok: true; role: Role; groups: string[] }
  | { ok: false; error: "not_in_allowed_group" | "no_access" };

/**
 * The sign-in gate (design §3.5 step 3), run before a user row is created and
 * on every sign-in.
 *
 * - `OIDC_ALLOWED_GROUPS`, if set, requires membership in one of the groups
 *   (OIDC only; GitHub sign-ins carry no groups and are refused then).
 * - With `OIDC_REQUIRE_VERIFIED_EMAIL` an unverified email does not count for
 *   email rules. With it off, the provider's email is trusted as verified.
 * - No resolvable role means no access.
 */
export function evaluateSignIn(
  identity: Identity,
  stored: StoredUserState,
  rules: RoleRules,
  gate: SignInGateConfig,
): SignInDecision {
  const groups = [...identity.groups];
  if (gate.allowedGroups.length > 0 && !matches(gate.allowedGroups, groups)) {
    return { ok: false, error: "not_in_allowed_group" };
  }
  const effectiveIdentity: Identity = {
    ...identity,
    emailVerified: gate.requireVerifiedEmail ? identity.emailVerified : true,
  };
  const role = resolveRole(effectiveIdentity, stored, rules);
  if (!role) return { ok: false, error: "no_access" };
  return { ok: true, role, groups };
}

/** Boot check: without an admin rule nobody could administer the instance. */
export function assertAdminRuleExists(
  rules: Pick<RoleRules, "adminEmails" | "adminGroups">,
) {
  if (rules.adminEmails.length === 0 && rules.adminGroups.length === 0) {
    throw new Error(
      "No admin rule configured: set ADMIN_EMAILS or ADMIN_GROUPS.",
    );
  }
}

/** Reads a groups claim that may be an array, a comma-separated string or absent. */
export function readGroupsClaim(
  profile: Record<string, unknown>,
  claim: string,
): string[] {
  const raw = profile[claim];
  if (Array.isArray(raw))
    return raw.filter((g): g is string => typeof g === "string");
  if (typeof raw === "string") return raw.split(/[,\s]+/).filter(Boolean);
  return [];
}
