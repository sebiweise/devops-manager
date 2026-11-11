import { describe, expect, it } from "vitest";
import { readEmailVerified, stripAccountTokens } from "./hooks";

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
