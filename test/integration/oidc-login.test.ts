import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OAuth2Server } from "oauth2-mock-server";
import type * as AuthRoute from "@/app/api/auth/[...all]/route";
import type * as Db from "@/server/db";

/**
 * OIDC sign-in end to end against a mock issuer (oauth2-mock-server): the
 * authorization code flow with PKCE and a nonce-bound ID token, through the
 * real `/api/auth/[...all]` route handlers and a real Postgres database.
 *
 * Covers the M0 acceptance criteria: sign-in without any GitHub account, the
 * sign-in gate (allowed groups, verified email, no role) refusing before a
 * user row exists, role resolution, no persisted provider tokens, and the
 * GitHub endpoints answering 404 while GitHub login is disabled.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const BASE = "http://localhost:3999";

type Claims = {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  groups?: string[];
};

let server: OAuth2Server;
let claims: Claims;
let route: typeof AuthRoute;
let db: typeof Db.db;

function setEnv(issuer: string) {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL,
    BETTER_AUTH_SECRET: "integration-secret-integration-secret-0001",
    BETTER_AUTH_URL: BASE,
    NEXT_PUBLIC_APP_URL: BASE,
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    CRON_SECRET: "integration-cron-secret-integration-cron-01",
    AUDIT_IP_SALT: "integration-audit-salt-integration-salt-01",
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: "devops-manager",
    OIDC_CLIENT_SECRET: "integration-client-secret",
    OIDC_SCOPES: "openid email profile groups",
    OIDC_ALLOWED_GROUPS: "devops-users",
    ADMIN_EMAILS: "admin@example.com",
    OPERATOR_GROUPS: "devops-operators",
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "example-devops-manager",
    GITHUB_APP_PRIVATE_KEY: "unused-in-this-test",
    ALLOWED_ACCOUNTS: "example-org",
    GITHUB_LOGIN_ENABLED: "false",
  });
  delete process.env.SKIP_ENV_VALIDATION;
}

/** Collects `name=value` pairs from Set-Cookie headers into a Cookie header. */
function mergeCookies(jar: Map<string, string>, res: Response) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const idx = pair!.indexOf("=");
    const name = pair!.slice(0, idx).trim();
    const value = pair!.slice(idx + 1);
    if (/max-age=0/i.test(line) || value === "") jar.delete(name);
    else jar.set(name, value);
  }
}

const cookieHeader = (jar: Map<string, string>) =>
  [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

/** Runs the whole browser flow; returns where the callback redirected to. */
async function signIn(): Promise<{
  location: string;
  jar: Map<string, string>;
}> {
  const jar = new Map<string, string>();

  const start = await route.POST(
    new Request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({
        provider: "oidc",
        callbackURL: "/dashboard",
        errorCallbackURL: "/login",
      }),
    }),
  );
  expect(start.status).toBe(200);
  mergeCookies(jar, start);
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorize.searchParams.get("nonce")).toBeTruthy();
  expect(authorize.searchParams.get("state")).toBeTruthy();

  const idp = await fetch(url, { redirect: "manual" });
  const callback = idp.headers.get("location");
  expect(callback).toMatch(/\/api\/auth\/callback\/oidc\?/);

  const done = await route.GET(
    new Request(callback!, { headers: { cookie: cookieHeader(jar) } }),
  );
  expect([301, 302, 303, 307]).toContain(done.status);
  mergeCookies(jar, done);
  return { location: done.headers.get("location") ?? "", jar };
}

async function resetAuthTables() {
  await db.session.deleteMany();
  await db.account.deleteMany();
  await db.verification.deleteMany();
  await db.user.deleteMany();
}

describe.skipIf(!DATABASE_URL)("OIDC sign-in (mock issuer)", () => {
  beforeAll(async () => {
    server = new OAuth2Server();
    await server.issuer.keys.generate("RS256");
    await server.start(0, "localhost");
    const issuer = server.issuer.url!;
    setEnv(issuer);

    server.service.on("beforeTokenSigning", (token) => {
      Object.assign(token.payload, { aud: "devops-manager", ...claims });
    });
    server.service.on("beforeUserinfo", (userInfoResponse) => {
      userInfoResponse.body = { ...claims };
    });

    route = await import("@/app/api/auth/[...all]/route");
    ({ db } = await import("@/server/db"));
  });

  afterAll(async () => {
    await server?.stop();
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await resetAuthTables();
  });

  it("signs in an admin by verified email, with no GitHub account involved", async () => {
    claims = {
      sub: "subject-admin",
      email: "admin@example.com",
      email_verified: true,
      name: "Example Admin",
      groups: ["devops-users"],
    };
    const { location, jar } = await signIn();
    expect(location).toBe("/dashboard");
    expect([...jar.keys()].some((k) => k.endsWith("dm.session_token"))).toBe(
      true,
    );

    const user = await db.user.findUniqueOrThrow({
      where: { email: "admin@example.com" },
    });
    expect(user.envRole).toBe("ADMIN");
    expect(user.oidcGroups).toEqual(["devops-users"]);
    expect(user.lastLoginAt).not.toBeNull();

    const accounts = await db.account.findMany({ where: { userId: user.id } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      providerId: "oidc",
      accountId: "subject-admin",
      accessToken: null,
      refreshToken: null,
      idToken: null,
    });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it("resolves a role from the groups claim", async () => {
    claims = {
      sub: "subject-operator",
      email: "someone@example.org",
      email_verified: true,
      groups: ["devops-users", "devops-operators"],
    };
    const { location } = await signIn();
    expect(location).toBe("/dashboard");
    const user = await db.user.findUniqueOrThrow({
      where: { email: "someone@example.org" },
    });
    expect(user.envRole).toBe("OPERATOR");
  });

  it("keeps provider tokens out of the database on a returning sign-in", async () => {
    claims = {
      sub: "subject-admin",
      email: "admin@example.com",
      email_verified: true,
      groups: ["devops-users"],
    };
    await signIn();
    const second = await signIn();
    expect(second.location).toBe("/dashboard");
    const accounts = await db.account.findMany();
    expect(accounts).toHaveLength(1);
    for (const a of accounts) {
      expect(a.accessToken).toBeNull();
      expect(a.refreshToken).toBeNull();
      expect(a.idToken).toBeNull();
    }
    expect(await db.session.count()).toBe(2);
  });

  it("refuses a user matching no role rule and creates no user row", async () => {
    claims = {
      sub: "subject-nobody",
      email: "nobody@example.com",
      email_verified: true,
      groups: ["devops-users"],
    };
    const { location } = await signIn();
    expect(location).toMatch(/^\/login\?error=no_access/);
    expect(await db.user.count()).toBe(0);
    expect(await db.account.count()).toBe(0);
  });

  it("does not apply email rules to an unverified email", async () => {
    claims = {
      sub: "subject-unverified",
      email: "admin@example.com",
      email_verified: false,
      groups: ["devops-users"],
    };
    const { location } = await signIn();
    expect(location).toMatch(/^\/login\?error=no_access/);
    expect(await db.user.count()).toBe(0);
  });

  it("refuses a user outside OIDC_ALLOWED_GROUPS even with an admin email", async () => {
    claims = {
      sub: "subject-outside",
      email: "admin@example.com",
      email_verified: true,
      groups: ["other"],
    };
    const { location } = await signIn();
    expect(location).toMatch(/^\/login\?error=not_in_allowed_group/);
    expect(await db.user.count()).toBe(0);
  });

  it("refuses a returning user whose groups no longer grant a role", async () => {
    claims = {
      sub: "subject-operator",
      email: "someone@example.org",
      email_verified: true,
      groups: ["devops-users", "devops-operators"],
    };
    await signIn();
    claims = { ...claims, groups: ["devops-users"] };
    const { location } = await signIn();
    expect(location).toMatch(/^\/login\?error=no_access/);
    expect(await db.session.count()).toBe(1);
  });

  it("answers 404 for GitHub sign-in and callback while GitHub login is disabled", async () => {
    const callback = await route.GET(
      new Request(`${BASE}/api/auth/callback/github?code=x&state=y`),
    );
    expect(callback.status).toBe(404);
    const start = await route.POST(
      new Request(`${BASE}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ provider: "github", callbackURL: "/dashboard" }),
      }),
    );
    expect(start.status).toBe(404);
  });
});
