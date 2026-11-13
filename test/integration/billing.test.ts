import { readFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { TenantScope } from "@/server/authz/scope";
import type * as Personal from "@/server/billing/personal";
import type * as Crypto from "@/server/crypto";
import type * as Costs from "@/server/data/costs";
import type * as Installations from "@/server/data/installations";
import type * as PersonalBilling from "@/server/data/personal-billing";
import type * as Db from "@/server/db";
import type { Fetch } from "@/server/github/billing-credential";
import type * as Billing from "@/server/ingest/billing";
import type * as Credential from "@/server/ingest/billing-credential";
import type * as Budget from "@/server/ingest/budget";
import type * as Inventory from "@/server/ingest/inventory";
import type * as Reconcile from "@/server/ingest/reconcile";
import {
  A,
  B,
  DATABASE_URL,
  FakeGitHub,
  resetTables,
  seedInstallations,
  setActionsEnv,
} from "./support/actions";

/**
 * Billing and the personal-account credential against a real Postgres, an
 * in-memory GitHub and a mocked OAuth token endpoint (design §3.4, §5.3 h,
 * §6.6, §13 M2): org billing via installation token, estimates-only
 * fallback, option A (env token, stored PAT with login check), option B
 * (Connect GitHub, refresh with rotation, revocation), encryption at rest,
 * nothing secret in audit params, and installation isolation.
 */

vi.mock("next/cache", () => ({ revalidateTag: () => undefined }));

const fixture = (name: string) =>
  (
    JSON.parse(
      readFileSync(
        new URL(`../fixtures/github/${name}`, import.meta.url),
        "utf8",
      ),
    ) as { usageItems: Array<Record<string, unknown>> }
  ).usageItems;

const PAT = "github_pat_" + "x".repeat(40); // gitleaks:allow (synthetic)
const CLIENT_ID = "Iv1.example";
const CLIENT_SECRET = "example-client-secret";

let db: typeof Db.db;
let reconcile: typeof Reconcile;
let budget: typeof Budget;
let billing: typeof Billing;
let credential: typeof Credential;
let costs: typeof Costs;
let personal: typeof Personal;
let personalBilling: typeof PersonalBilling;
let inventory: typeof Inventory;
let crypto: typeof Crypto;
let installations: typeof Installations;

const scope = (
  installationIds: bigint[] = [A, B],
  role: TenantScope["role"] = "ADMIN",
): TenantScope => ({ userId: "user-admin", role, installationIds });

/** App users (roles re-resolved live by the pipeline from these e-mails). */
const USERS: Record<string, { name: string; email: string }> = {
  "user-admin": { name: "Admin", email: "admin@example.com" },
  "user-other": { name: "Other admin", email: "other-admin@example.com" },
  "user-viewer": { name: "Viewer", email: "viewer@example.com" },
};

const actor = (s: TenantScope = scope()) => ({
  user: { id: s.userId, ...USERS[s.userId]! },
  scope: s,
});

/** A mocked github.com / api.github.com for the OAuth flows. */
class FakeOAuth {
  readonly calls: Array<{ url: string; body: string; method: string }> = [];
  /** Valid refresh token -> next generation number. */
  refreshTokens = new Map<string, number>();
  users = new Map<string, { id: number; login: string }>();
  /** `x-oauth-scopes` GET /user answers with for a token (classic tokens). */
  scopes = new Map<string, string>();
  codes = new Map<string, { challenge: string; login: string }>();
  /** Login of every issued refresh token. */
  refreshOwner = new Map<string, string>();
  /** Access tokens passed to DELETE .../token. */
  revoked: string[] = [];
  /** Access tokens passed to DELETE .../grant. */
  grantsRevoked: string[] = [];
  /** Status the revocation endpoints answer with instead of 204. */
  revokeStatus: number | null = null;
  delayMs = 0;
  generation = 0;

  constructor(private readonly gh: FakeGitHub) {}

  fetch: Fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const method = init?.method ?? "GET";
    this.calls.push({ url, body, method });
    const json = (status: number, data: unknown) =>
      new Response(status === 204 ? null : JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === "https://github.com/login/oauth/access_token") {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      const p = new URLSearchParams(body);
      if (
        p.get("client_id") !== CLIENT_ID ||
        p.get("client_secret") !== CLIENT_SECRET
      )
        return json(200, { error: "incorrect_client_credentials" });
      let login: string;
      if (p.get("grant_type") === "refresh_token") {
        const old = p.get("refresh_token") ?? "";
        if (!this.refreshTokens.has(old))
          return json(200, { error: "bad_refresh_token" });
        // Rotation: the used refresh token stops working.
        this.refreshTokens.delete(old);
        login = this.refreshOwner.get(old) ?? "example-user";
      } else {
        const code = this.codes.get(p.get("code") ?? "");
        const { createHash } = await import("node:crypto");
        const challenge = createHash("sha256")
          .update(p.get("code_verifier") ?? "")
          .digest("base64url");
        if (!code || code.challenge !== challenge)
          return json(200, { error: "bad_verification_code" });
        login = code.login;
      }
      const n = ++this.generation;
      const access = `ghu_gen${n}`;
      const refresh = `ghr_gen${n}`;
      this.refreshTokens.set(refresh, n);
      this.refreshOwner.set(refresh, login);
      this.gh.userTokens.set(access, login);
      this.users.set(access, {
        id: login === "example-user" ? 4242 : 5151,
        login,
      });
      return json(200, {
        access_token: access,
        expires_in: 28_800,
        refresh_token: refresh,
        refresh_token_expires_in: 15_897_600,
        token_type: "bearer",
        scope: "",
      });
    }
    if (url === "https://api.github.com/user") {
      const auth =
        (init?.headers as Record<string, string>).authorization ?? "";
      const token = auth.replace(/^Bearer /, "");
      const user = this.users.get(token);
      if (!user) return json(401, { message: "Bad credentials" });
      const scopes = this.scopes.get(token);
      return new Response(JSON.stringify(user), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(scopes != null ? { "x-oauth-scopes": scopes } : {}),
        },
      });
    }
    if (
      url === `https://api.github.com/applications/${CLIENT_ID}/token` &&
      method === "DELETE"
    ) {
      if (this.revokeStatus) return json(this.revokeStatus, {});
      const token = JSON.parse(body).access_token as string;
      if (!this.users.has(token)) return json(404, {});
      this.revoked.push(token);
      this.users.delete(token);
      return json(204, null);
    }
    if (
      url === `https://api.github.com/applications/${CLIENT_ID}/grant` &&
      method === "DELETE"
    ) {
      if (this.revokeStatus) return json(this.revokeStatus, {});
      const token = JSON.parse(body).access_token as string;
      const user = this.users.get(token);
      if (!user) return json(404, {});
      this.grantsRevoked.push(token);
      // The whole authorisation ends: every token of that user.
      for (const [t, u] of [...this.users])
        if (u.login === user.login) this.users.delete(t);
      for (const [r, login] of this.refreshOwner)
        if (login === user.login) this.refreshTokens.delete(r);
      return json(204, null);
    }
    return json(404, {});
  };

  deps(now = () => new Date(this.gh.now)): Credential.CredentialDeps {
    return {
      app: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      fetch: this.fetch,
      now,
      envToken: null,
    };
  }
}

async function runBilling(
  gh: FakeGitHub,
  installationId: bigint,
  credentials?: Credential.CredentialDeps,
) {
  const inst = await db.installation.findUniqueOrThrow({
    where: { id: installationId },
  });
  return billing.syncBilling(
    {
      id: inst.id,
      accountLogin: inst.accountLogin,
      accountType: inst.accountType,
      permissions: inst.permissions as Record<string, unknown>,
      billingSyncedAt: inst.billingSyncedAt,
    },
    gh.clients(),
    new budget.Deadline(gh.now + 600_000, gh.clock),
    { force: true, credentials },
  );
}

const sumNet = (items: Array<Record<string, unknown>>, actionsOnly = true) =>
  items
    .filter((i) => /^\d{4}-\d{2}-\d{2}/.test(String(i.date)))
    .filter(
      (i) => !actionsOnly || String(i.product).toLowerCase() === "actions",
    )
    .reduce((s, i) => s + Number(i.netAmount), 0);

describe.skipIf(!DATABASE_URL)("billing", () => {
  beforeAll(async () => {
    setActionsEnv({
      GITHUB_CONNECT_ENABLED: "true",
      GITHUB_APP_CLIENT_ID: CLIENT_ID,
      GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
      ADMIN_EMAILS: "admin@example.com,other-admin@example.com",
      VIEWER_EMAILS: "viewer@example.com",
    });
    ({ db } = await import("@/server/db"));
    reconcile = await import("@/server/ingest/reconcile");
    budget = await import("@/server/ingest/budget");
    billing = await import("@/server/ingest/billing");
    credential = await import("@/server/ingest/billing-credential");
    costs = await import("@/server/data/costs");
    personal = await import("@/server/billing/personal");
    personalBilling = await import("@/server/data/personal-billing");
    inventory = await import("@/server/ingest/inventory");
    crypto = await import("@/server/crypto");
    installations = await import("@/server/data/installations");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await resetTables(db);
    await db.$executeRawUnsafe(
      `TRUNCATE "RateLimitBucket", "Session", "Account", "User" CASCADE`,
    );
    for (const [id, u] of Object.entries(USERS))
      await db.user.create({
        data: { id, name: u.name, email: u.email, emailVerified: true },
      });
  });

  it("syncs org billing with the sync.billing token; totals equal the report's netAmount", async () => {
    await seedInstallations(db, {
      permissions: { organization_administration: "read" },
    });
    const gh = new FakeGitHub();
    const items = fixture("billing-usage-org.json");
    gh.billing.set("example-org", items);
    const res = await reconcile.runReconcile({
      deadline: new budget.Deadline(gh.now + 600_000, gh.clock),
      clients: gh.clients(),
      installationId: B,
      config: { backfillDays: 1 },
    });
    expect(res.installations[0]!.billing).toMatchObject({ status: "ok" });
    expect(gh.tokens).toContainEqual({
      installationId: B,
      purpose: "sync.billing",
    });

    const c = await costs.getCosts(scope(), B, undefined, new Date(gh.now));
    expect(c.source).toBe("billed");
    expect(c.reason).toBeNull();
    expect(c.totals.netUsd).toBeCloseTo(sumNet(items), 4);
    expect(c.totals.netUsdAllProducts).toBeCloseTo(sumNet(items, false), 4);
    const linux = c.bySku.find((s) => s.skuKey === "linux")!;
    expect(linux).toMatchObject({
      sku: "Actions Linux",
      billedQuantity: 370,
      minuteMultiplier: 1,
    });
    const mac = c.bySku.find((s) => s.skuKey === "macos")!;
    expect(mac.minuteMultiplier).toBe(10);
    // used = Σ minutes × multiplier: 370 × 1 + 30 × 10
    expect(c.included.used).toBe(670);
    expect(c.included.included).toBe(2_000);
    expect(c.byRepo.map((r) => r.repositoryFullName).sort()).toEqual([
      "example-org/repo-b",
      "example-org/repo-c",
    ]);
    expect(c.byDay.reduce((s, d) => s + d.netUsd, 0)).toBeCloseTo(
      c.totals.netUsd,
      4,
    );

    // A second sync replaces the month instead of adding to it.
    await runBilling(gh, B);
    const again = await costs.getCosts(scope(), B, undefined, new Date(gh.now));
    expect(again.totals.netUsd).toBeCloseTo(c.totals.netUsd, 6);
  });

  it("falls back to estimates without the org permission, and for a personal account without a credential", async () => {
    await seedInstallations(db);
    const { forgetSkuRates, loadSkuRates } =
      await import("@/server/ingest/sku-rates");
    // SkuRate is not tenant data and survives resets: start from the seed.
    await db.skuRate.updateMany({
      where: { sku: "linux" },
      data: { pricePerMinuteUsd: 0.008 },
    });
    forgetSkuRates();
    await loadSkuRates();
    const gh = new FakeGitHub();
    gh.addRun(A, { createdAt: new Date(gh.now - 3_600_000), durationS: 61 });
    await reconcile.runReconcile({
      deadline: new budget.Deadline(gh.now + 600_000, gh.clock),
      clients: gh.clients(),
      installationId: A,
      config: { backfillDays: 1 },
    });
    await runBilling(gh, B);

    const org = await costs.getCosts(scope(), B, undefined, new Date(gh.now));
    expect(org).toMatchObject({ source: "estimate", reason: "no_permission" });
    const user = await costs.getCosts(scope(), A, undefined, new Date(gh.now));
    expect(user).toMatchObject({ source: "estimate", reason: "no_credential" });
    expect(user.adminNotice).toEqual({ error: null, reconnect: false });
    // 61 s on a private Linux runner = 2 minutes at the seeded rate.
    expect(user.totals.estMin).toBe(2);
    expect(user.totals.estUsd).toBeCloseTo(0.016, 6);
    expect(user.included.used).toBe(2);
    // Viewers get the same numbers, without the admin notice.
    const viewer = await costs.getCosts(
      scope([A, B], "VIEWER"),
      A,
      undefined,
      new Date(gh.now),
    );
    expect(viewer.adminNotice).toBeNull();

    // A changed SkuRate changes the estimate without a deploy.
    await db.skuRate.updateMany({
      where: { sku: "linux" },
      data: { pricePerMinuteUsd: 0.01 },
    });
    forgetSkuRates();
    const changed = await costs.getCosts(
      scope(),
      A,
      undefined,
      new Date(gh.now),
    );
    expect(changed.totals.estUsd).toBeCloseTo(0.02, 6);
    await db.skuRate.updateMany({
      where: { sku: "linux" },
      data: { pricePerMinuteUsd: 0.008 },
    });
    forgetSkuRates();
  });

  it("option A: uses GITHUB_BILLING_TOKEN for the single personal installation, without storing it", async () => {
    await seedInstallations(db);
    const gh = new FakeGitHub();
    const items = fixture("billing-usage-user.json");
    gh.billing.set("example-user", items);
    gh.userTokens.set("env-billing-token", "example-user");
    const res = await runBilling(gh, A, {
      app: null,
      fetch: async () => new Response(null, { status: 500 }),
      now: () => new Date(gh.now),
      envToken: "env-billing-token",
    });
    expect(res.status).toBe("ok");
    expect(await db.gitHubCredential.count()).toBe(0);
    const c = await costs.getCosts(scope(), A, undefined, new Date(gh.now));
    expect(c.source).toBe("billed");
    expect(c.totals.netUsd).toBeCloseTo(sumNet(items), 6);
  });

  it("option A: stores a PAT encrypted after checking its login; rejects another account", async () => {
    await seedInstallations(db);
    const gh = new FakeGitHub();
    const oauth = new FakeOAuth(gh);
    const deps = { fetch: oauth.fetch, now: () => new Date(gh.now) };

    oauth.users.set(PAT, { id: 5151, login: "example-other" });
    expect(
      await personal.storeBillingToken(
        actor(),
        { installationId: A, token: PAT, confirmation: "example-user" },
        deps,
      ),
    ).toEqual({ status: "login_mismatch", login: "example-other" });
    expect(await db.gitHubCredential.count()).toBe(0);

    oauth.users.set(PAT, { id: 4242, login: "example-user" });
    expect(
      await personal.storeBillingToken(
        actor(),
        { installationId: A, token: PAT, confirmation: "wrong" },
        deps,
      ),
    ).toEqual({ status: "confirmation_mismatch" });
    expect(
      await personal.storeBillingToken(
        actor(),
        { installationId: A, token: PAT, confirmation: "example-user" },
        deps,
      ),
    ).toEqual({ status: "saved", login: "example-user" });

    // Ciphertext at rest, bound to the row and column; round trip works.
    const row = await db.gitHubCredential.findUniqueOrThrow({
      where: { installationId: A },
    });
    expect(row.kind).toBe("PAT");
    expect(row.githubUserId).toBe(4242n);
    expect(row.accessToken).toMatch(/^v1:/);
    expect(row.accessToken).not.toContain(PAT);
    expect(
      crypto.decryptToken(
        row.accessToken!,
        credential.credentialAad(A, "accessToken"),
      ),
    ).toBe(PAT);
    expect(() =>
      crypto.decryptToken(
        row.accessToken!,
        credential.credentialAad(B, "accessToken"),
      ),
    ).toThrow();

    // Nothing secret in the audit log (instance chain).
    const audit = await db.auditLog.findMany({
      where: { installationId: 0n },
      orderBy: { seq: "asc" },
    });
    expect(audit.map((a) => [a.action, a.status])).toEqual([
      ["BILLING_CREDENTIAL_SET", "FAILED"],
      ["BILLING_CREDENTIAL_SET", "SUCCEEDED"],
    ]);
    for (const a of audit)
      expect(JSON.stringify({ ...a, seq: 0, installationId: 0 })).not.toContain(
        PAT,
      );

    // The billing step uses it; totals equal the report.
    const items = fixture("billing-usage-user.json");
    gh.billing.set("example-user", items);
    gh.userTokens.set(PAT, "example-user");
    expect((await runBilling(gh, A, oauth.deps())).status).toBe("ok");
    const c = await costs.getCosts(scope(), A, undefined, new Date(gh.now));
    expect(c.totals.netUsd).toBeCloseTo(sumNet(items), 6);
    const status = await personalBilling.listBillingCredentials(
      scope(),
      new Date(gh.now),
    );
    expect(status.installations[0]).toMatchObject({
      accountLogin: "example-user",
      state: "pat",
      githubLogin: "example-user",
    });
    expect(JSON.stringify(status)).not.toContain(PAT);

    // A 401 later shows the reconnect state and falls back to estimates.
    gh.userTokens.delete(PAT);
    expect((await runBilling(gh, A, oauth.deps())).status).toBe(
      "credential_error",
    );
    const after = await costs.getCosts(scope(), A, undefined, new Date(gh.now));
    expect(after.adminNotice?.reconnect).toBe(true);
  });

  it("option B: refreshes an expired token once and persists the rotated refresh token", async () => {
    await seedInstallations(db);
    const gh = new FakeGitHub();
    const oauth = new FakeOAuth(gh);
    oauth.refreshTokens.set("ghr_initial", 0);
    await credential.saveCredential({
      installationId: A,
      kind: "USER_TO_SERVER",
      owner: { id: 4242n, login: "example-user" },
      tokens: {
        accessToken: "ghu_initial",
        accessTokenExpiresAt: new Date(gh.now - 60_000), // expired
        refreshToken: "ghr_initial",
        refreshTokenExpiresAt: new Date(gh.now + 30 * 86_400_000),
      },
      createdByUserId: "user-admin",
    });

    // Two concurrent callers: the row lock lets exactly one refresh.
    oauth.delayMs = 200;
    const [t1, t2] = await Promise.all([
      credential.billingTokenFor(A, oauth.deps()),
      credential.billingTokenFor(A, oauth.deps()),
    ]);
    expect(t1).toEqual({
      kind: "token",
      source: "USER_TO_SERVER",
      token: "ghu_gen1",
    });
    expect(t2).toEqual(t1);
    expect(
      oauth.calls.filter((c) => c.url.endsWith("/login/oauth/access_token")),
    ).toHaveLength(1);

    const row = await db.gitHubCredential.findUniqueOrThrow({
      where: { installationId: A },
    });
    expect(
      crypto.decryptToken(
        row.refreshToken!,
        credential.credentialAad(A, "refreshToken"),
      ),
    ).toBe("ghr_gen1");
    expect(row.refreshToken).not.toContain("ghr_gen1");
    expect(row.accessTokenExpiresAt!.getTime()).toBe(gh.now + 28_800_000);
    expect(row.lastRefreshedAt).not.toBeNull();

    // The refreshed token reads billing.
    gh.billing.set("example-user", fixture("billing-usage-user.json"));
    expect((await runBilling(gh, A, oauth.deps())).status).toBe("ok");

    // Eight hours later the next refresh uses the rotated token.
    const later = () => new Date(gh.now + 9 * 3_600_000);
    const t3 = await credential.billingTokenFor(A, oauth.deps(later));
    expect(t3).toMatchObject({ kind: "token", token: "ghu_gen2" });
    const refreshes = oauth.calls
      .filter((c) => c.url.endsWith("/login/oauth/access_token"))
      .map((c) => new URLSearchParams(c.body).get("refresh_token"));
    expect(refreshes).toEqual(["ghr_initial", "ghr_gen1"]);
  });

  it("option B: a rejected refresh token or a revoked authorisation asks admins to reconnect", async () => {
    await seedInstallations(db);
    const gh = new FakeGitHub();
    const oauth = new FakeOAuth(gh);
    const save = (refresh: string) =>
      credential.saveCredential({
        installationId: A,
        kind: "USER_TO_SERVER",
        owner: { id: 4242n, login: "example-user" },
        tokens: {
          accessToken: "ghu_old",
          accessTokenExpiresAt: new Date(gh.now - 1),
          refreshToken: refresh,
          refreshTokenExpiresAt: new Date(gh.now + 86_400_000),
        },
        createdByUserId: "user-admin",
      });

    await save("ghr_unknown"); // GitHub answers bad_refresh_token
    expect(await credential.billingTokenFor(A, oauth.deps())).toEqual({
      kind: "reconnect",
      reason: "reconnect_required",
    });
    expect((await runBilling(gh, A, oauth.deps())).status).toBe(
      "credential_error",
    );
    let c = await costs.getCosts(scope(), A, undefined, new Date(gh.now));
    expect(c).toMatchObject({ source: "estimate", reason: "credential_error" });
    expect(c.adminNotice?.reconnect).toBe(true);
    const row = await db.gitHubCredential.findUniqueOrThrow({
      where: { installationId: A },
    });
    expect(row).toMatchObject({ accessToken: null, refreshToken: null });
    expect(row.revokedAt).not.toBeNull();

    // github_app_authorization.revoked wipes a working credential.
    oauth.refreshTokens.set("ghr_valid", 0);
    await save("ghr_valid");
    await inventory.handleAppAuthorizationEvent({
      action: "revoked",
      sender: { id: 4242, login: "example-user" },
    });
    const revoked = await db.gitHubCredential.findUniqueOrThrow({
      where: { installationId: A },
    });
    expect(revoked).toMatchObject({
      accessToken: null,
      refreshToken: null,
      lastError: "reconnect_required",
    });
    const status = await personalBilling.listBillingCredentials(scope());
    expect(status.installations[0]!.state).toBe("reconnect");
    c = await costs.getCosts(scope(), A, undefined, new Date(gh.now));
    expect(c.adminNotice?.reconnect).toBe(true);
  });

  it('option B: "Connect GitHub" binds the state to the admin and checks the login', async () => {
    await seedInstallations(db);
    const gh = new FakeGitHub();
    const oauth = new FakeOAuth(gh);
    const deps = { fetch: oauth.fetch, now: () => new Date(gh.now) };

    const started = await personal.startConnect(
      actor(),
      { installationId: A },
      deps,
    );
    expect(started.status).toBe("redirect");
    const url = new URL(started.url!);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3999/api/github/connect/callback",
    );
    const state = url.searchParams.get("state")!;
    oauth.codes.set("code-1", {
      challenge: url.searchParams.get("code_challenge")!,
      login: "example-user",
    });

    // Another app user cannot complete this admin's flow (and burns the state).
    const other = actor({ ...scope(), userId: "user-other" });
    expect(
      await personal.completeConnect(other, { code: "code-1", state }, deps),
    ).toEqual({ status: "invalid_state" });

    const again = await personal.startConnect(
      actor(),
      { installationId: A },
      deps,
    );
    const url2 = new URL(again.url!);
    oauth.codes.set("code-2", {
      challenge: url2.searchParams.get("code_challenge")!,
      login: "example-user",
    });
    expect(
      await personal.completeConnect(
        actor(),
        { code: "code-2", state: url2.searchParams.get("state")! },
        deps,
      ),
    ).toEqual({ status: "connected", login: "example-user" });
    // A state is single use.
    expect(
      await personal.completeConnect(
        actor(),
        { code: "code-2", state: url2.searchParams.get("state")! },
        deps,
      ),
    ).toEqual({ status: "invalid_state" });

    const row = await db.gitHubCredential.findUniqueOrThrow({
      where: { installationId: A },
    });
    expect(row).toMatchObject({
      kind: "USER_TO_SERVER",
      githubLogin: "example-user",
    });
    expect(row.accessToken).toMatch(/^v1:/);
    expect(row.refreshTokenExpiresAt).not.toBeNull();

    // Connecting a different GitHub account is rejected and given back.
    const third = await personal.startConnect(
      actor(),
      { installationId: A },
      deps,
    );
    const url3 = new URL(third.url!);
    oauth.codes.set("code-3", {
      challenge: url3.searchParams.get("code_challenge")!,
      login: "example-other",
    });
    expect(
      await personal.completeConnect(
        actor(),
        { code: "code-3", state: url3.searchParams.get("state")! },
        deps,
      ),
    ).toEqual({ status: "login_mismatch", login: "example-other" });
    // The other account's authorisation is given back as a whole.
    expect(oauth.grantsRevoked).toHaveLength(1);
    // The stored credential is untouched.
    const kept = await db.gitHubCredential.findUniqueOrThrow({
      where: { installationId: A },
    });
    expect(kept.githubLogin).toBe("example-user");

    // Revoke: the grant is revoked at GitHub and the row deleted.
    expect(
      await personal.revokeBillingCredential(
        actor(),
        { installationId: A, confirmation: "example-user" },
        deps,
      ),
    ).toEqual({ status: "revoked" });
    expect(oauth.grantsRevoked).toHaveLength(2);
    expect(oauth.refreshTokens.size).toBe(0);
    expect(await db.gitHubCredential.count()).toBe(0);
    const audit = await db.auditLog.findMany({
      where: { installationId: 0n },
      orderBy: { seq: "asc" },
    });
    expect(audit.map((a) => a.action)).toEqual([
      "BILLING_CREDENTIAL_CONNECT",
      "BILLING_CREDENTIAL_CONNECT",
      "BILLING_CREDENTIAL_REVOKE",
    ]);
    expect(audit[2]!.params).toMatchObject({ remoteRevocation: "revoked" });
    for (const a of audit)
      expect(JSON.stringify(a.params)).not.toMatch(/gh[ur]_/);
  });

  it("revoke ends the whole grant even after the access token expired, and keeps the row when GitHub fails", async () => {
    await seedInstallations(db);
    const gh = new FakeGitHub();
    const oauth = new FakeOAuth(gh);
    const deps = { fetch: oauth.fetch, now: () => new Date(gh.now) };
    oauth.refreshTokens.set("ghr_initial", 0);
    oauth.refreshOwner.set("ghr_initial", "example-user");
    await credential.saveCredential({
      installationId: A,
      kind: "USER_TO_SERVER",
      owner: { id: 4242n, login: "example-user" },
      tokens: {
        accessToken: "ghu_initial",
        accessTokenExpiresAt: new Date(gh.now - 3_600_000), // the usual case
        refreshToken: "ghr_initial",
        refreshTokenExpiresAt: new Date(gh.now + 30 * 86_400_000),
      },
      createdByUserId: "user-admin",
    });

    // GitHub fails: nothing is deleted, the rotated token is kept for a retry.
    oauth.revokeStatus = 500;
    expect(
      await personal.revokeBillingCredential(
        actor(),
        { installationId: A, confirmation: "example-user" },
        deps,
      ),
    ).toEqual({ status: "revoke_failed" });
    const kept = await db.gitHubCredential.findUniqueOrThrow({
      where: { installationId: A },
    });
    expect(
      crypto.decryptToken(
        kept.refreshToken!,
        credential.credentialAad(A, "refreshToken"),
      ),
    ).toBe("ghr_gen1");

    // Retry: the fresh access token identifies the grant, which is revoked.
    oauth.revokeStatus = null;
    expect(
      await personal.revokeBillingCredential(
        actor(),
        { installationId: A, confirmation: "example-user" },
        deps,
      ),
    ).toEqual({ status: "revoked" });
    expect(oauth.grantsRevoked).toEqual(["ghu_gen1"]);
    // No refresh token of that user is left at GitHub.
    expect(oauth.refreshTokens.size).toBe(0);
    expect(await db.gitHubCredential.count()).toBe(0);
    const audit = await db.auditLog.findMany({
      where: { installationId: 0n },
      orderBy: { seq: "asc" },
    });
    expect(
      audit.map((a) => [
        a.status,
        (a.params as { remoteRevocation?: string }).remoteRevocation,
      ]),
    ).toEqual([
      ["FAILED", "failed"],
      ["SUCCEEDED", "revoked"],
    ]);
    for (const a of audit)
      expect(JSON.stringify(a.params)).not.toMatch(/gh[ur]_/);
  });

  it("replacing a connected credential revokes the old one at GitHub", async () => {
    await seedInstallations(db);
    const gh = new FakeGitHub();
    const oauth = new FakeOAuth(gh);
    const deps = { fetch: oauth.fetch, now: () => new Date(gh.now) };
    const connect = async (code: string) => {
      const started = await personal.startConnect(
        actor(),
        { installationId: A },
        deps,
      );
      const url = new URL(started.url!);
      oauth.codes.set(code, {
        challenge: url.searchParams.get("code_challenge")!,
        login: "example-user",
      });
      return personal.completeConnect(
        actor(),
        { code, state: url.searchParams.get("state")! },
        deps,
      );
    };

    // Reconnect as the same user: only the old token pair is revoked, never
    // the grant the new token belongs to.
    expect(await connect("code-1")).toMatchObject({ status: "connected" });
    expect(await connect("code-2")).toMatchObject({ status: "connected" });
    expect(oauth.revoked).toEqual(["ghu_gen1"]);
    expect(oauth.grantsRevoked).toEqual([]);
    expect(oauth.users.has("ghu_gen2")).toBe(true);

    // Switching to a PAT revokes the connected grant first.
    oauth.users.set(PAT, { id: 4242, login: "example-user" });
    expect(
      await personal.storeBillingToken(
        actor(),
        { installationId: A, token: PAT, confirmation: "example-user" },
        deps,
      ),
    ).toEqual({ status: "saved", login: "example-user" });
    expect(oauth.grantsRevoked).toEqual(["ghu_gen2"]);
    expect(oauth.refreshTokens.size).toBe(0);
    const audit = await db.auditLog.findMany({
      where: { installationId: 0n },
      orderBy: { seq: "asc" },
    });
    expect(
      audit.map((a) => [
        a.action,
        (a.params as { previousRevocation?: string }).previousRevocation,
      ]),
    ).toEqual([
      ["BILLING_CREDENTIAL_CONNECT", "not_needed"],
      ["BILLING_CREDENTIAL_CONNECT", "revoked"],
      ["BILLING_CREDENTIAL_SET", "revoked"],
    ]);
  });

  it("option A refuses classic and scoped tokens as too broad", async () => {
    await seedInstallations(db);
    const gh = new FakeGitHub();
    const oauth = new FakeOAuth(gh);
    const deps = { fetch: oauth.fetch, now: () => new Date(gh.now) };
    const classic = "ghp_" + "y".repeat(36); // gitleaks:allow (synthetic)
    oauth.users.set(classic, { id: 4242, login: "example-user" });
    expect(
      await personal.storeBillingToken(
        actor(),
        { installationId: A, token: classic, confirmation: "example-user" },
        deps,
      ),
    ).toEqual({ status: "token_too_broad" });
    // Never sent to GitHub.
    expect(oauth.calls).toHaveLength(0);

    oauth.users.set(PAT, { id: 4242, login: "example-user" });
    oauth.scopes.set(PAT, "repo, admin:org");
    expect(
      await personal.storeBillingToken(
        actor(),
        { installationId: A, token: PAT, confirmation: "example-user" },
        deps,
      ),
    ).toEqual({ status: "token_too_broad" });
    expect(await db.gitHubCredential.count()).toBe(0);
  });

  it("runs through the management pipeline: one call per key, kill switch, instance chain", async () => {
    await seedInstallations(db);
    const gh = new FakeGitHub();
    const oauth = new FakeOAuth(gh);
    oauth.users.set(PAT, { id: 4242, login: "example-user" });
    const key = "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const deps = { fetch: oauth.fetch, now: () => new Date(gh.now) };
    const input = {
      installationId: A,
      token: PAT,
      confirmation: "example-user",
      idempotencyKey: key,
    };
    expect(await personal.storeBillingToken(actor(), input, deps)).toEqual({
      status: "saved",
      login: "example-user",
    });
    const calls = oauth.calls.length;
    // A double submit answers from the audit row and calls GitHub no more.
    expect(await personal.storeBillingToken(actor(), input, deps)).toEqual({
      status: "replayed",
    });
    expect(oauth.calls).toHaveLength(calls);
    const rows = await db.auditLog.findMany({
      where: { idempotencyKey: key },
    });
    expect(rows.map((r) => [r.installationId, r.status])).toEqual([
      [0n, "SUCCEEDED"],
    ]);
    // The global kill switch blocks credential changes as well.
    const { defaultActionDeps } = await import("@/server/authz/action");
    expect(
      await personal.revokeBillingCredential(
        actor(),
        { installationId: A, confirmation: "example-user" },
        {
          ...deps,
          action: defaultActionDeps({ managementEnabled: false }),
        },
      ),
    ).toEqual({ status: "management_disabled" });
    expect(await db.gitHubCredential.count()).toBe(1);
  });

  it("an empty usage report after a successful sync is billed at $0, not an estimate", async () => {
    await seedInstallations(db, {
      permissions: { organization_administration: "read" },
    });
    const gh = new FakeGitHub();
    gh.billing.set("example-org", []);
    gh.addRun(B, { createdAt: new Date(gh.now - 3_600_000), durationS: 61 });
    expect((await runBilling(gh, B)).status).toBe("ok");
    const c = await costs.getCosts(scope(), B, undefined, new Date(gh.now));
    expect(c).toMatchObject({ source: "billed", reason: null });
    expect(c.totals.netUsd).toBe(0);
    expect(c.totals.netUsdAllProducts).toBe(0);
    // A month the sync never read stays an estimate.
    const earlier = await costs.getCosts(
      scope(),
      B,
      { year: 2020, month: 1 },
      new Date(gh.now),
    );
    expect(earlier).toMatchObject({ source: "estimate", reason: "not_synced" });
  });

  it("keeps installations and roles apart", async () => {
    await seedInstallations(db, {
      permissions: { organization_administration: "read" },
    });
    const gh = new FakeGitHub();
    gh.billing.set("example-org", fixture("billing-usage-org.json"));
    await runBilling(gh, B);
    const NotFound = installations.NotFoundError;

    // A scope with only A sees nothing of B.
    await expect(costs.getCosts(scope([A]), B)).rejects.toBeInstanceOf(
      NotFound,
    );
    const a = await costs.getCosts(scope([A]), A, undefined, new Date(gh.now));
    expect(a.totals.netUsdAllProducts).toBe(0);
    // Credentials: admin only, personal installations only, scoped.
    await expect(
      personalBilling.listBillingCredentials(scope([A, B], "OPERATOR")),
    ).rejects.toBeInstanceOf(NotFound);
    expect(
      (await personalBilling.listBillingCredentials(scope([B]))).installations,
    ).toHaveLength(0);
    await expect(
      personal.storeBillingToken(actor(), {
        installationId: B,
        token: PAT,
        confirmation: "example-org",
      }),
    ).rejects.toBeInstanceOf(NotFound);
    await expect(
      personal.storeBillingToken(actor(scope([B])), {
        installationId: A,
        token: PAT,
        confirmation: "example-user",
      }),
    ).rejects.toBeInstanceOf(NotFound);
    // A viewer is denied (and audited), before any GitHub call.
    expect(
      await personal.storeBillingToken(
        actor({ ...scope([A, B], "VIEWER"), userId: "user-viewer" }),
        {
          installationId: A,
          token: PAT,
          confirmation: "example-user",
        },
      ),
    ).toEqual({ status: "forbidden" });
    const denied = await db.auditLog.findMany({ where: { status: "DENIED" } });
    expect(denied.map((d) => d.action)).toEqual(["BILLING_CREDENTIAL_SET"]);
    expect(await db.gitHubCredential.count()).toBe(0);
  });
});
