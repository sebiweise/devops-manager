import { describe, expect, it } from "vitest";
import {
  hashIp,
  pseudonymiseSessionIp,
  readEmailVerified,
  stripAccountTokens,
} from "./hooks";

const SALT = "s".repeat(32);

describe("session IP pseudonymisation", () => {
  it("stores an HMAC instead of the raw IP", () => {
    const out = pseudonymiseSessionIp(
      { userId: "u", ipAddress: "203.0.113.7", userAgent: "ua" },
      SALT,
    );
    expect(out.ipAddress).toBe(hashIp("203.0.113.7", SALT));
    expect(out.ipAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(out)).not.toContain("203.0.113.7");
    expect(out.userAgent).toBe("ua");
  });

  it("is stable per salt and differs across salts", () => {
    expect(hashIp("203.0.113.7", SALT)).toBe(hashIp(" 203.0.113.7 ", SALT));
    expect(hashIp("203.0.113.7", SALT)).not.toBe(
      hashIp("203.0.113.7", "t".repeat(32)),
    );
  });

  it("leaves rows without an ipAddress field alone and nulls empty values", () => {
    expect(pseudonymiseSessionIp({ userId: "u" }, SALT)).toEqual({
      userId: "u",
    });
    expect(pseudonymiseSessionIp({ ipAddress: "" }, SALT).ipAddress).toBeNull();
  });
});

describe("account hook token dropping", () => {
  it("removes access, refresh and ID tokens and their expiry", () => {
    const account = {
      providerId: "oidc",
      accountId: "subject-1",
      userId: "user-1",
      accessToken: "access",
      refreshToken: "refresh",
      idToken: "id.token.value",
      accessTokenExpiresAt: new Date(),
      refreshTokenExpiresAt: new Date(),
      scope: "openid email profile",
    };
    const stripped = stripAccountTokens(account);
    expect(stripped).toMatchObject({
      providerId: "oidc",
      accountId: "subject-1",
      userId: "user-1",
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: "openid email profile",
    });
    // The input object is not mutated.
    expect(account.accessToken).toBe("access");
  });

  it("does not add token fields to partial updates", () => {
    expect(stripAccountTokens({ scope: "openid" })).toEqual({
      scope: "openid",
    });
    expect(stripAccountTokens({ accessToken: "x" })).toEqual({
      accessToken: null,
    });
  });
});

describe("readEmailVerified", () => {
  it("accepts boolean and string claims", () => {
    expect(readEmailVerified({ email_verified: true })).toBe(true);
    expect(readEmailVerified({ email_verified: "true" })).toBe(true);
    expect(readEmailVerified({ emailVerified: true })).toBe(true);
    expect(readEmailVerified({ email_verified: false })).toBe(false);
    expect(readEmailVerified({ email_verified: "false" })).toBe(false);
    expect(readEmailVerified({})).toBe(false);
  });
});
