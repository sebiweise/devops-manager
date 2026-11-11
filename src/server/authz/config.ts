import "server-only";
import { csv, env } from "@/env";
import { type RoleRules, type SignInGateConfig } from "./roles";

export function roleRulesFromEnv(): RoleRules {
  return {
    adminEmails: csv(env.ADMIN_EMAILS),
    adminGroups: csv(env.ADMIN_GROUPS),
    operatorEmails: csv(env.OPERATOR_EMAILS),
    operatorGroups: csv(env.OPERATOR_GROUPS),
    viewerEmails: csv(env.VIEWER_EMAILS),
    viewerGroups: csv(env.VIEWER_GROUPS),
    defaultRole: env.DEFAULT_ROLE,
  };
}

export function signInGateFromEnv(): SignInGateConfig {
  return {
    allowedGroups: csv(env.OIDC_ALLOWED_GROUPS),
    requireVerifiedEmail: env.OIDC_REQUIRE_VERIFIED_EMAIL,
  };
}

/** Lowercased GitHub account logins whose installations are accepted. */
export function allowedAccounts(): Set<string> {
  return new Set(csv(env.ALLOWED_ACCOUNTS).map((s) => s.toLowerCase()));
}

export function isAllowedAccount(login: string | null | undefined): boolean {
  return !!login && allowedAccounts().has(login.toLowerCase());
}
