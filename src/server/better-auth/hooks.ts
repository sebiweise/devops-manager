/**
 * Pure helpers used by the better-auth database hooks.
 */

/** Token columns of better-auth's account model. */
export const ACCOUNT_TOKEN_FIELDS = [
  "accessToken",
  "refreshToken",
  "idToken",
] as const;

/**
 * Drops provider tokens before an account row is written (design §3.4/§3.5).
 *
 * Sign-in needs the tokens only during the callback; the app never calls the
 * OIDC provider or GitHub with them afterwards. Keeping them would turn every
 * DB read into a credential leak. Expiry timestamps go as well, since they
 * describe tokens that no longer exist.
 */
export function stripAccountTokens<T extends Record<string, unknown>>(
  account: T,
): T {
  const out: Record<string, unknown> = { ...account };
  for (const field of ACCOUNT_TOKEN_FIELDS) {
    if (field in out) out[field] = null;
  }
  if ("accessTokenExpiresAt" in out) out.accessTokenExpiresAt = null;
  if ("refreshTokenExpiresAt" in out) out.refreshTokenExpiresAt = null;
  return out as T;
}

/** Reads `email_verified` from an OIDC profile, accepting boolean or string forms. */
export function readEmailVerified(profile: Record<string, unknown>): boolean {
  const raw = profile.email_verified ?? profile.emailVerified;
  return raw === true || raw === "true";
}
