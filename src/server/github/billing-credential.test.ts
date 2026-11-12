import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  fetchTokenOwner,
  GitHubHttpError,
  OAuthError,
  parseTokenExpiry,
  parseTokenResponse,
  refreshUserToken,
  revokeUserToken,
  sameLogin,
  type Fetch,
} from "./billing-credential";

const APP = { clientId: "Iv1.example", clientSecret: "example-client-secret" };
const NOW = new Date("2026-11-12T08:00:00Z");

type Call = { url: string; init?: RequestInit };

function fakeFetch(
  respond: (call: Call) => {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
  },
): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      const r = respond(call);
      const status = r.status ?? 200;
      return new Response(
        status === 204 ? null : JSON.stringify(r.body ?? {}),
        {
          status,
          headers: { "content-type": "application/json", ...(r.headers ?? {}) },
        },
      );
    },
  };
}

describe("token endpoint", () => {
  it("parses a token set with absolute expiries", () => {
    const set = parseTokenResponse(
      200,
      {
        access_token: "ghu_example",
        expires_in: 28_800,
        refresh_token: "ghr_example",
        refresh_token_expires_in: 15_897_600,
      },
      NOW,
    );
    expect(set.accessTokenExpiresAt!.getTime()).toBe(
      NOW.getTime() + 28_800_000,
    );
    expect(set.refreshTokenExpiresAt!.getTime()).toBe(
      NOW.getTime() + 15_897_600_000,
    );
  });

  it("turns an `error` field with status 200 into an OAuthError", () => {
    expect(() =>
      parseTokenResponse(200, { error: "bad_refresh_token" }, NOW),
    ).toThrow(OAuthError);
    try {
      parseTokenResponse(200, { error: "bad_refresh_token" }, NOW);
    } catch (error) {
      expect((error as OAuthError).reconnectRequired).toBe(true);
    }
    expect(
      new OAuthError("incorrect_client_credentials", 200).reconnectRequired,
    ).toBe(false);
  });

  it("refreshes with grant_type=refresh_token and returns the rotated tokens", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: {
        access_token: "ghu_new",
        expires_in: 28_800,
        refresh_token: "ghr_new",
        refresh_token_expires_in: 15_897_600,
        token_type: "bearer",
        scope: "",
      },
    }));
    const set = await refreshUserToken(APP, "ghr_old", fetch, NOW);
    expect(set).toMatchObject({
      accessToken: "ghu_new",
      refreshToken: "ghr_new",
    });
    expect(calls[0]!.url).toBe("https://github.com/login/oauth/access_token");
    const body = new URLSearchParams(String(calls[0]!.init!.body));
    expect(Object.fromEntries(body)).toEqual({
      client_id: APP.clientId,
      client_secret: APP.clientSecret,
      grant_type: "refresh_token",
      refresh_token: "ghr_old",
    });
    expect((calls[0]!.init!.headers as Record<string, string>).accept).toBe(
      "application/json",
    );
  });

  it("sends the PKCE verifier with the code exchange", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { access_token: "ghu_x", expires_in: 28_800 },
    }));
    await exchangeCode(
      APP,
      "code-1",
      "verifier-1",
      "https://devops.example.com/cb",
      fetch,
      NOW,
    );
    const body = new URLSearchParams(String(calls[0]!.init!.body));
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("grant_type")).toBeNull();
  });

  it("revokes with Basic auth of the App client", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 204 }));
    await revokeUserToken(APP, "ghu_x", fetch);
    expect(calls[0]!.url).toBe(
      "https://api.github.com/applications/Iv1.example/token",
    );
    expect(calls[0]!.init!.method).toBe("DELETE");
    const auth = (calls[0]!.init!.headers as Record<string, string>)
      .authorization;
    expect(Buffer.from(auth!.replace("Basic ", ""), "base64").toString()).toBe(
      `${APP.clientId}:${APP.clientSecret}`,
    );
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      access_token: "ghu_x",
    });
  });

  it("treats 404 on revoke as already revoked, other errors as failures", async () => {
    await expect(
      revokeUserToken(APP, "ghu_x", fakeFetch(() => ({ status: 404 })).fetch),
    ).resolves.toBeUndefined();
    await expect(
      revokeUserToken(APP, "ghu_x", fakeFetch(() => ({ status: 500 })).fetch),
    ).rejects.toBeInstanceOf(GitHubHttpError);
  });
});

describe("token owner", () => {
  it("reads id, login and the PAT expiry header", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { id: 42, login: "example-user" },
      headers: {
        "github-authentication-token-expiration": "2026-12-01 10:00:00 UTC",
      },
    }));
    const owner = await fetchTokenOwner("github_pat_example", fetch);
    expect(owner).toEqual({
      id: 42n,
      login: "example-user",
      tokenExpiresAt: new Date("2026-12-01T10:00:00Z"),
    });
    expect(
      (calls[0]!.init!.headers as Record<string, string>).authorization,
    ).toBe("Bearer github_pat_example");
  });

  it("rejects a bad token with its status", async () => {
    await expect(
      fetchTokenOwner("x", fakeFetch(() => ({ status: 401 })).fetch),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("parses expiry header variants", () => {
    expect(parseTokenExpiry("2026-12-01 10:00:00 +0100")!.toISOString()).toBe(
      "2026-12-01T09:00:00.000Z",
    );
    expect(parseTokenExpiry(null)).toBeNull();
    expect(parseTokenExpiry("soon")).toBeNull();
  });

  it("compares logins case-insensitively", () => {
    expect(sameLogin("Example-User", "example-user")).toBe(true);
    expect(sameLogin("example-org", "example-user")).toBe(false);
  });
});

describe("authorize URL", () => {
  it("uses PKCE S256 and the state", () => {
    const pkce = createPkce();
    expect(pkce.challenge).toBe(
      createHash("sha256").update(pkce.verifier).digest("base64url"),
    );
    expect(pkce.challenge).toHaveLength(43);
    const url = new URL(
      authorizeUrl({
        clientId: APP.clientId,
        redirectUri: "https://devops.example.com/api/github/connect/callback",
        state: "state-1",
        codeChallenge: pkce.challenge,
        login: "example-user",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("login")).toBe("example-user");
  });
});
