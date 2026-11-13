import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as ActionModule from "@/server/authz/action";
import type { TenantScope } from "@/server/authz/scope";
import type * as AuditData from "@/server/data/audit";
import type * as VercelData from "@/server/data/vercel";
import type * as Db from "@/server/db";
import type * as Budget from "@/server/ingest/budget";
import type * as Prune from "@/server/ingest/prune";
import type * as Reconcile from "@/server/ingest/reconcile";
import type * as Triggers from "@/server/ingest/triggers";
import type * as Connect from "@/server/ingest/vercel-connect";
import type * as Credential from "@/server/ingest/vercel-credential";
import type * as Hints from "@/server/ingest/vercel-hints";
import type * as Step from "@/server/ingest/vercel-reconcile";
import type * as Management from "@/server/management/vercel";
import { createKeyRing } from "@/server/crypto/keyring";
import {
  A,
  B,
  DATABASE_URL,
  FakeGitHub,
  resetTables,
  seedInstallations,
  setActionsEnv,
} from "./support/actions";
import { ENV_SECRET_VALUE, FakeVercel } from "./support/vercel";

/**
 * Vercel M5 (design addendum §12) against a real Postgres and FakeVercel:
 * connect/rotate/disconnect with audit rows that never hold the token,
 * rejected tokens, reconcile step v (cursor overlap, resume after a
 * deadline, 429 pause, 401 revocation without repeated calls), GitHub
 * deployment hints, findings, prune, two-tenant isolation of every
 * data/vercel.ts function, the full-DB plaintext grep, and GET-only calls.
 */

vi.mock("next/cache", () => ({ revalidateTag: () => undefined }));

const PREVIOUS_KEY = Buffer.alloc(32, 9).toString("base64");
const TOKEN_A = "vcp_teamscopedtokenaaaaaaaaaaaaaa1111";
const TOKEN_FULL = "vcp_fullaccounttokenbbbbbbbbbbbbbb2222";
const TOKEN_B = "vcp_otherteamtokencccccccccccccccc3333";
const TEAM_A = "team_testAAAAAAAAAAAA";
const TEAM_B = "team_testBBBBBBBBBBBB";
const DAY = 86_400_000;
const json = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) =>
    typeof x === "bigint" ? String(x) : x,
  );
const SHA = (n: number) => n.toString(16).padStart(40, "0");

type Role = TenantScope["role"];
const USERS: Record<Role, { id: string; email: string }> = {
  VIEWER: { id: "user-viewer", email: "viewer@example.com" },
  OPERATOR: { id: "user-operator", email: "operator@example.com" },
  ADMIN: { id: "user-admin", email: "admin@example.com" },
};

function actor(role: Role, installationIds: bigint[] = [A, B]) {
  const u = USERS[role];
  return {
    user: { id: u.id, name: role.toLowerCase(), email: u.email },
    scope: { userId: u.id, role, installationIds },
    ipHash: "a".repeat(64),
    userAgent: "vitest",
  };
}

let db: typeof Db.db;
let action: typeof ActionModule;
let mgmt: typeof Management;
let data: typeof VercelData;
let auditData: typeof AuditData;
let step: typeof Step;
let reconcile: typeof Reconcile;
let budget: typeof Budget;
let hints: typeof Hints;
let credential: typeof Credential;
let connect: typeof Connect;
let prune: typeof Prune;
let triggers: typeof Triggers;

describe.skipIf(!DATABASE_URL)("vercel (M5)", () => {
  let vc: FakeVercel;
  const logs: string[] = [];
  const deps = (over: Partial<Management.VercelDeps> = {}) =>
    mgmt.defaultVercelDeps({
      clients: new FakeGitHub().clients(),
      revalidate: () => undefined,
      managementEnabled: true,
      mergeAuditTrailer: false,
      fetch: vc.fetch(),
      schedule: () => undefined,
      ...over,
    });

  beforeAll(async () => {
    setActionsEnv({
      OPERATOR_EMAILS: USERS.OPERATOR.email,
      VIEWER_EMAILS: USERS.VIEWER.email,
      ADMIN_EMAILS: USERS.ADMIN.email,
      TOKEN_ENCRYPTION_KEY_PREVIOUS: PREVIOUS_KEY,
    });
    ({ db } = await import("@/server/db"));
    action = await import("@/server/authz/action");
    mgmt = await import("@/server/management/vercel");
    data = await import("@/server/data/vercel");
    auditData = await import("@/server/data/audit");
    step = await import("@/server/ingest/vercel-reconcile");
    reconcile = await import("@/server/ingest/reconcile");
    budget = await import("@/server/ingest/budget");
    hints = await import("@/server/ingest/vercel-hints");
    credential = await import("@/server/ingest/vercel-credential");
    connect = await import("@/server/ingest/vercel-connect");
    prune = await import("@/server/ingest/prune");
    triggers = await import("@/server/ingest/triggers");
    for (const level of ["log", "warn", "error", "info"] as const) {
      const orig = console[level].bind(console);
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(
          args
            .map((a) => (a instanceof Error ? a.message : String(a)))
            .join(" "),
        );
        void orig;
      });
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await db?.$disconnect();
  });

  beforeEach(async () => {
    connect.resetEnvAttempts();
    await resetTables(db);
    await db.$executeRawUnsafe(
      `TRUNCATE "RateLimitBucket", "Session", "Account", "User" CASCADE`,
    );
    await seedInstallations(db);
    await db.installation.updateMany({
      data: { permissionsCheckedAt: new Date() },
    });
    for (const role of ["VIEWER", "OPERATOR", "ADMIN"] as const)
      await db.user.create({
        data: {
          id: USERS[role].id,
          name: role.toLowerCase(),
          email: USERS[role].email,
          emailVerified: true,
        },
      });
    vc = new FakeVercel();
    vc.addTeam({ id: TEAM_A, slug: "team-a", name: "Team A", plan: "hobby" });
    vc.addTeam({ id: TEAM_B, slug: "team-b", name: "Team B", plan: "pro" });
    vc.tokens.set(TOKEN_A, {
      teams: [TEAM_A],
      expiresAt: Date.now() + 90 * DAY,
    });
    vc.tokens.set(TOKEN_FULL, { teams: [], full: true });
    vc.tokens.set(TOKEN_B, { teams: [TEAM_B] });
    // Team A: project-a linked to example-user/repo-a (A's repo 11),
    // project-b linked to example-org/repo-b (22, installation B), project-c via CLI.
    vc.projects.push(
      {
        id: "prj_testA1",
        teamId: TEAM_A,
        name: "project-a",
        repoId: 11,
        repo: "example-user/repo-a",
        liveProductionId: "dpl_testA_p2",
      },
      {
        id: "prj_testA2",
        teamId: TEAM_A,
        name: "project-b",
        repoId: 22,
        repo: "example-org/repo-b",
      },
      { id: "prj_testA3", teamId: TEAM_A, name: "project-c" },
      {
        id: "prj_testB1",
        teamId: TEAM_B,
        name: "project-z",
        repoId: 22,
        repo: "example-org/repo-b",
      },
    );
    const now = Date.now();
    const add = (
      uid: string,
      projectId: string,
      ageMs: number,
      state: string,
      target: "production" | null,
      sha: number,
      ref = "main",
    ) =>
      vc.addDeployment({
        uid,
        teamId: projectId.startsWith("prj_testB") ? TEAM_B : TEAM_A,
        projectId,
        name:
          projectId === "prj_testA1"
            ? "project-a"
            : projectId === "prj_testA2"
              ? "project-b"
              : projectId === "prj_testA3"
                ? "project-c"
                : "project-z",
        createdAt: now - ageMs,
        readyState: state,
        target,
        sha: SHA(sha),
        ref,
      });
    add("dpl_testA_p1", "prj_testA1", 60 * DAY, "READY", "production", 1);
    add("dpl_testA_p2", "prj_testA1", 2 * DAY, "READY", "production", 2);
    add("dpl_testA_v1", "prj_testA1", 1 * DAY, "READY", null, 3, "feature/x");
    add("dpl_testA_p3", "prj_testA1", 3_600_000, "ERROR", "production", 4);
    add("dpl_testA_old", "prj_testA1", 120 * DAY, "READY", null, 5, "old");
    for (let i = 0; i < 230; i++)
      add(
        `dpl_testA_bulk${i}`,
        "prj_testA3",
        (i + 1) * 3 * 3_600_000,
        i % 7 === 0 ? "ERROR" : "READY",
        null,
        1000 + i,
        `branch-${i % 5}`,
      );
    add("dpl_testB_1", "prj_testB1", DAY, "READY", "production", 9);
    logs.length = 0;
  });

  afterEach(() => {
    expect(vc.decryptRequested).toBe(false);
  });

  const connectA = (
    role: Role = "ADMIN",
    token = TOKEN_A,
    teamId?: string,
    key = randomUUID(),
  ) =>
    mgmt.connectVercel(
      actor(role),
      {
        installationId: A,
        token,
        teamId,
        confirmed: true,
        idempotencyKey: key,
      },
      deps(),
    );

  const sync = async (opts: { force?: boolean; clockStepMs?: number } = {}) => {
    let clock = Date.now();
    if (opts.clockStepMs) vc.onRequest = () => (clock += opts.clockStepMs!);
    const d = new budget.Deadline(clock + 240_000, () => clock);
    const result = await step.runVercelStep({
      installationId: A,
      timezone: "UTC",
      retentionDays: 90,
      deadline: d,
      forceProjects: opts.force,
      fetch: vc.fetch(),
      envToken: null,
    });
    vc.onRequest = undefined;
    return result;
  };

  describe("connect", () => {
    it("connects a team-scoped token, audits without the token and syncs 90 days", async () => {
      const res = await connectA();
      expect(res).toMatchObject({
        status: "succeeded",
        data: { teamSlug: "team-a", scope: "team" },
      });
      const conn = await db.vercelConnection.findUniqueOrThrow({
        where: { installationId: A },
      });
      expect(conn.teamId).toBe(TEAM_A);
      expect(conn.tokenSource).toBe("DB");
      expect(conn.accessToken).toMatch(/^v1:/);
      expect(conn.accessToken).not.toContain(TOKEN_A);
      expect(conn.tokenHint).toBe("1111");
      expect(conn.plan).toBe("hobby");
      const audit = await db.auditLog.findFirstOrThrow({
        where: { action: "VERCEL_CONNECT" },
      });
      expect(audit.status).toBe("SUCCEEDED");
      expect(audit.installationId).toBe(A);
      expect(audit.actingAs).toBe("vercel:token:1111");
      expect(json(audit)).not.toContain(TOKEN_A);
      expect(audit.params).toMatchObject({
        teamSlug: "team-a",
        tokenHint: "1111",
        scope: "team",
      });
      expect((await auditData.verifyAuditLog(actor("ADMIN").scope, A)).ok).toBe(
        true,
      );

      // One Sync now (forced v1) brings the projects and 90 days of deployments.
      const r = await sync({ force: true });
      expect(r.status).toBe("ok");
      const projects = await db.vercelProject.findMany({
        where: { installationId: A },
        orderBy: { id: "asc" },
      });
      expect(projects.map((p) => p.id)).toEqual([
        "prj_testA1",
        "prj_testA2",
        "prj_testA3",
      ]);
      const count = await db.vercelDeployment.count({
        where: { installationId: A },
      });
      // 4 of project-a inside 90 days + 230 bulk; the 120-day-old one is outside.
      expect(count).toBe(234);
      expect(
        await db.vercelDeployment.findUnique({
          where: { id: "dpl_testA_old" },
        }),
      ).toBeNull();
      // Only GETs, and every team call carries this team's id.
      expect(vc.calls.every((c) => c.method === "GET")).toBe(true);
      expect(
        vc.calls
          .filter((c) => c.query.teamId)
          .every((c) => c.query.teamId === TEAM_A),
      ).toBe(true);
      const stats = await db.dailyDeploymentStat.count({
        where: { installationId: A },
      });
      expect(stats).toBeGreaterThan(20);
    });

    it("answers a double submit with the first result and one validation", async () => {
      const key = randomUUID();
      await connectA("ADMIN", TOKEN_A, undefined, key);
      const calls = vc.calls.length;
      const again = await connectA("ADMIN", TOKEN_A, undefined, key);
      expect(again).toMatchObject({ status: "succeeded", replayed: true });
      expect(vc.calls.length).toBe(calls);
      expect(
        await db.auditLog.count({ where: { action: "VERCEL_CONNECT" } }),
      ).toBe(1);
    });

    it("rejects wrong, revoked and ambiguous full-account tokens with a clear reason", async () => {
      const wrong = await connectA(
        "ADMIN",
        "vcp_unknowntokenzzzzzzzzzzzzzzzzzz9999",
      );
      expect(wrong).toMatchObject({
        status: "failed",
        message: "invalid_token",
      });
      vc.tokens.get(TOKEN_A)!.revoked = true;
      expect(await connectA()).toMatchObject({
        status: "failed",
        message: "invalid_token",
      });
      // Full-account token reaching two teams, no team id: ambiguous.
      expect(await connectA("ADMIN", TOKEN_FULL)).toMatchObject({
        status: "failed",
        message: "team_required",
      });
      // A team the token cannot reach.
      expect(await connectA("ADMIN", TOKEN_B, TEAM_A)).toMatchObject({
        status: "failed",
        message: "team_mismatch",
      });
      expect(await db.vercelConnection.count()).toBe(0);
      const rows = await db.auditLog.findMany({
        where: { action: "VERCEL_CONNECT" },
      });
      expect(rows.every((r) => r.status === "FAILED")).toBe(true);
      expect(json(rows)).not.toMatch(/vcp_[a-z]{10}/);
      // With the team id the full-account token is accepted and flagged.
      const ok = await connectA("ADMIN", TOKEN_FULL, TEAM_A);
      expect(ok).toMatchObject({
        status: "succeeded",
        data: { scope: "full" },
      });
    });

    it("refuses a team that is connected to another installation without telling which", async () => {
      await connectA();
      const res = await mgmt.connectVercel(
        actor("ADMIN"),
        {
          installationId: B,
          token: TOKEN_A,
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      expect(res).toMatchObject({
        status: "failed",
        message: "already_connected_elsewhere",
      });
      expect(JSON.stringify(res)).not.toContain("example-user");
      expect(await db.vercelConnection.count()).toBe(1);
    });

    it("lets viewers see the connection but not connect", async () => {
      const res = await connectA("VIEWER");
      expect(res).toEqual({ status: "forbidden" });
      const denied = await db.auditLog.findFirstOrThrow({
        where: { action: "VERCEL_CONNECT" },
      });
      expect(denied.status).toBe("DENIED");
      expect(vc.calls).toHaveLength(0);
      await connectA();
      expect(
        await data.getVercelSummary(actor("VIEWER").scope, A),
      ).toMatchObject({ teamSlug: "team-a" });
      await expect(
        data.getVercelSettings(actor("VIEWER").scope, A),
      ).rejects.toBeInstanceOf(Error);
    });

    it("is blocked by the global kill switch only", async () => {
      const res = await mgmt.connectVercel(
        actor("ADMIN"),
        {
          installationId: A,
          token: TOKEN_A,
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps({ managementEnabled: false }),
      );
      expect(res).toEqual({ status: "management_disabled", level: "global" });
      // The installation toggle (off in this seed) does not matter.
      expect(await connectA()).toMatchObject({ status: "succeeded" });
    });

    it("rotates the token of the same team and refuses another team", async () => {
      await connectA();
      await db.vercelConnection.update({
        where: { installationId: A },
        data: { revokedAt: new Date(), lastSyncStatus: "credential_error" },
      });
      vc.tokens.set("vcp_rotatedtokendddddddddddddddd4444", {
        teams: [TEAM_A],
      });
      const ok = await mgmt.rotateVercelToken(
        actor("ADMIN"),
        {
          installationId: A,
          token: "vcp_rotatedtokendddddddddddddddd4444",
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      expect(ok).toMatchObject({ status: "succeeded" });
      const conn = await db.vercelConnection.findUniqueOrThrow({
        where: { installationId: A },
      });
      expect(conn.revokedAt).toBeNull();
      expect(conn.tokenHint).toBe("4444");
      const other = await mgmt.rotateVercelToken(
        actor("ADMIN"),
        {
          installationId: A,
          token: TOKEN_B,
          teamId: TEAM_B,
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      expect(other).toMatchObject({ status: "failed" });
      expect(
        (
          await db.vercelConnection.findUniqueOrThrow({
            where: { installationId: A },
          })
        ).tokenHint,
      ).toBe("4444");
    });

    it("disconnects with the typed team slug and keeps the audit rows", async () => {
      await connectA();
      await sync({ force: true });
      const wrong = await mgmt.disconnectVercel(
        actor("ADMIN"),
        { installationId: A, typed: "team-x", idempotencyKey: randomUUID() },
        deps(),
      );
      expect(wrong).toEqual({ status: "confirmation_mismatch" });
      const ok = await mgmt.disconnectVercel(
        actor("ADMIN"),
        { installationId: A, typed: "team-a", idempotencyKey: randomUUID() },
        deps(),
      );
      expect(ok).toMatchObject({ status: "succeeded" });
      expect(await db.vercelConnection.count()).toBe(0);
      expect(await db.vercelProject.count()).toBe(0);
      expect(await db.vercelDeployment.count()).toBe(0);
      expect(await db.dailyDeploymentStat.count()).toBe(0);
      expect(
        await db.auditLog.count({
          where: { action: { in: ["VERCEL_CONNECT", "VERCEL_DISCONNECT"] } },
        }),
      ).toBe(2);
      expect((await auditData.verifyAuditLog(actor("ADMIN").scope, A)).ok).toBe(
        true,
      );
    });
  });

  describe("reconcile step v", () => {
    beforeEach(async () => {
      await connectA();
      vc.calls.length = 0;
    });

    it("resolves links only inside the installation and derives latest production", async () => {
      await sync({ force: true });
      const p = await db.vercelProject.findMany({
        where: { installationId: A },
        orderBy: { id: "asc" },
      });
      expect(p[0]).toMatchObject({
        repositoryId: 11n,
        latestProdDeploymentId: "dpl_testA_p3",
        latestProdState: "ERROR",
        liveProdDeploymentId: "dpl_testA_p2",
      });
      // project-b points at B's repo 22: never resolved under A.
      expect(p[1]).toMatchObject({ linkRepoId: 22n, repositoryId: null });
      expect(p[2]).toMatchObject({ linkRepoId: null, repositoryId: null });
      const failing = await db.finding.findFirstOrThrow({
        where: { installationId: A, ruleKey: "vercel:prod-failing:prj_testA1" },
      });
      expect(failing).toMatchObject({
        status: "OPEN",
        severity: "HIGH",
        source: "VERCEL",
      });
      // Production is still served by the ready p2, not pinned to an older one.
      expect(p[0]!.autoAssignPausedAt).toBeNull();
    });

    it("overlaps the cursor without duplicates and picks up new deployments", async () => {
      await sync({ force: true });
      const before = await db.vercelDeployment.count();
      vc.addDeployment({
        uid: "dpl_testA_new",
        teamId: TEAM_A,
        projectId: "prj_testA1",
        name: "project-a",
        createdAt: Date.now() - 1000,
        readyState: "BUILDING",
        target: null,
        sha: SHA(77),
        ref: "feature/y",
      });
      const r = await sync();
      expect(r.status).toBe("ok");
      expect(await db.vercelDeployment.count()).toBe(before + 1);
      // The incremental pass asked only for the overlap window, not 90 days.
      const list = vc.callsTo("/v7/deployments").at(-1)!;
      expect(Number(list.query.since)).toBeGreaterThan(Date.now() - DAY);
      // Then it finishes building: the non-terminal refresh reads it with v13.
      vc.deployments.find((d) => d.uid === "dpl_testA_new")!.readyState =
        "READY";
      await sync();
      expect(
        (
          await db.vercelDeployment.findUniqueOrThrow({
            where: { id: "dpl_testA_new" },
          })
        ).state,
      ).toBe("READY");
      expect(
        vc.callsTo("/v13/deployments/dpl_testA_new").length,
      ).toBeGreaterThan(0);
    });

    it("stops at the step budget mid-pagination and resumes from the cursor", async () => {
      // Every request costs 8 s of the 25 s budget: a pass reads a few pages.
      const first = await sync({ force: true, clockStepMs: 8_000 });
      expect(first.status).toBe("partial");
      const conn = await db.vercelConnection.findUniqueOrThrow({
        where: { installationId: A },
      });
      expect(conn.deploymentsPageNext).not.toBeNull();
      expect(conn.deploymentsCursor).toBeNull();
      let status = first.status;
      for (let i = 0; i < 10 && status !== "ok"; i++)
        status = (await sync({ clockStepMs: 8_000 })).status;
      expect(status).toBe("ok");
      expect(
        await db.vercelDeployment.count({ where: { installationId: A } }),
      ).toBe(234);
      const done = await db.vercelConnection.findUniqueOrThrow({
        where: { installationId: A },
      });
      expect(done.deploymentsPageNext).toBeNull();
      expect(done.deploymentsCursor).not.toBeNull();
    });

    it("pauses on 429 until the retry time without further calls", async () => {
      vc.failNext("/v7/deployments", 429, {
        error: {
          code: "rate_limited",
          message: "slow down",
          limit: { resetMs: Date.now() + 120_000 },
        },
      });
      const r = await sync({ force: true });
      expect(r.status).toBe("rate_limited");
      const conn = await db.vercelConnection.findUniqueOrThrow({
        where: { installationId: A },
      });
      expect(conn.lastSyncStatus).toBe("rate_limited");
      expect(conn.pausedUntil!.getTime()).toBeGreaterThan(Date.now() + 60_000);
      const calls = vc.calls.length;
      expect((await sync()).status).toBe("rate_limited");
      expect(vc.calls.length).toBe(calls);
    });

    it("revokes on 401, raises a finding and makes no further calls", async () => {
      await sync({ force: true });
      vc.tokens.get(TOKEN_A)!.revoked = true;
      const r = await sync();
      expect(r.status).toBe("credential_error");
      const conn = await db.vercelConnection.findUniqueOrThrow({
        where: { installationId: A },
      });
      expect(conn.revokedAt).not.toBeNull();
      expect(conn.lastSyncStatus).toBe("credential_error");
      expect(conn.lastError ?? "").not.toContain(TOKEN_A);
      const calls = vc.calls.length;
      expect((await sync()).status).toBe("credential_error");
      expect(vc.calls.length).toBe(calls);
      const items = await data.listNeedsAttention(actor("VIEWER").scope, A);
      expect(items.map((i) => i.kind)).toEqual(
        expect.arrayContaining(["credential_revoked", "prod_failing"]),
      );
    });

    it("lists an expiring token and a failing production in Needs attention", async () => {
      await db.vercelConnection.update({
        where: { installationId: A },
        data: { tokenExpiresAt: new Date(Date.now() + 5 * DAY) },
      });
      await sync({ force: true });
      const items = await data.listNeedsAttention(actor("VIEWER").scope, A);
      expect(items.map((i) => i.kind).sort()).toEqual([
        "prod_failing",
        "token_expiring",
      ]);
      // Fixed when the next production deployment is ready.
      vc.addDeployment({
        uid: "dpl_testA_p4",
        teamId: TEAM_A,
        projectId: "prj_testA1",
        name: "project-a",
        createdAt: Date.now() - 500,
        readyState: "READY",
        target: "production",
        sha: SHA(88),
      });
      vc.projects[0]!.liveProductionId = "dpl_testA_p4";
      await sync();
      const after = await data.listNeedsAttention(actor("VIEWER").scope, A);
      expect(after.map((i) => i.kind)).toEqual(["token_expiring"]);
    });

    it("marks production pinned to an older deployment as auto-assign paused", async () => {
      vc.projects[0]!.liveProductionId = "dpl_testA_p1";
      vc.deployments.find((d) => d.uid === "dpl_testA_p3")!.readyState =
        "READY";
      await sync({ force: true });
      await sync({ force: true });
      const p = await db.vercelProject.findUniqueOrThrow({
        where: { id: "prj_testA1" },
      });
      expect(p.autoAssignPausedAt).not.toBeNull();
      const items = await data.listNeedsAttention(actor("VIEWER").scope, A);
      expect(items.map((i) => i.kind)).toContain("auto_assign_paused");
    });

    it("is part of the reconcile pass and Sync now forces the project list", async () => {
      const deadline = new budget.Deadline(Date.now() + 120_000);
      const res = await reconcile.runReconcile({
        deadline,
        clients: new FakeGitHub().clients(),
        installationId: A,
        vercel: { forceProjects: true, fetch: vc.fetch(), envToken: null },
      });
      expect(res.installations[0]!.vercel?.status).toBe("ok");
      expect(vc.callsTo("/v10/projects").length).toBe(1);
    });

    it("keeps lazy and full passes from overlapping", async () => {
      await db.installation.update({
        where: { id: A },
        data: { reconcileLockedUntil: new Date(Date.now() + 60_000) },
      });
      expect(await triggers.claimLazyVercel(A)).toBe(false);
      await db.installation.update({
        where: { id: A },
        data: { reconcileLockedUntil: null },
      });
      expect(await triggers.claimLazyVercel(A)).toBe(true);
      // The claim holds the lock: a full reconcile cannot claim now.
      expect(await reconcile.claimInstallation(A, new Date())).toBe(false);
      await db.installation.update({
        where: { id: A },
        data: { reconcileLockedUntil: null },
      });
      // Fresh data (synced within 5 minutes): no lazy pass.
      await sync({ force: true });
      expect(await triggers.claimLazyVercel(A)).toBe(false);
    });

    it("prunes old deployments but keeps the latest production and preview per branch", async () => {
      await sync({ force: true });
      await db.vercelDeployment.updateMany({
        where: { installationId: A },
        data: { createdAt: new Date(Date.now() - 200 * DAY) },
      });
      await prune.pruneInstallation(
        A,
        90,
        new budget.Deadline(Date.now() + 60_000),
      );
      const left = await db.vercelDeployment.findMany({
        where: { installationId: A },
        select: { projectId: true, target: true, branch: true },
      });
      const keys = left.map(
        (d) =>
          `${d.projectId}:${d.target}:${d.target === "production" ? "" : d.branch}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
      // project-a: production + preview main? (feature/x) ; project-c: 5 branches.
      expect(keys).toEqual(
        expect.arrayContaining([
          "prj_testA1:production:",
          "prj_testA1:preview:feature/x",
        ]),
      );
      expect(left.filter((d) => d.projectId === "prj_testA3")).toHaveLength(5);
    });
  });

  describe("GitHub deployment hints", () => {
    beforeEach(async () => {
      await connectA();
      await sync({ force: true });
      vc.calls.length = 0;
    });

    it("marks the linked project dirty and refreshes it from Vercel", async () => {
      vc.addDeployment({
        uid: "dpl_testA_hint",
        teamId: TEAM_A,
        projectId: "prj_testA1",
        name: "project-a",
        createdAt: Date.now() - 2000,
        readyState: "READY",
        target: null,
        sha: SHA(99),
        ref: "feature/z",
      });
      const ids = await hints.foldDeploymentHint(
        A,
        { repository: { id: 11 } },
        new Date(),
      );
      expect(ids).toEqual(["prj_testA1"]);
      expect(
        (
          await db.vercelProject.findUniqueOrThrow({
            where: { id: "prj_testA1" },
          })
        ).dirtyAt,
      ).not.toBeNull();
      const r = await hints.refreshFromHint(A, ids, { fetch: vc.fetch() });
      expect(r?.status).toBe("ok");
      expect(vc.calls.length).toBeLessThanOrEqual(3);
      expect(
        (
          await db.vercelDeployment.findUniqueOrThrow({
            where: { id: "dpl_testA_hint" },
          })
        ).state,
      ).toBe("READY");
      expect(
        (
          await db.vercelProject.findUniqueOrThrow({
            where: { id: "prj_testA1" },
          })
        ).dirtyAt,
      ).toBeNull();
      // Debounced: a second hint within 30 s makes no call.
      const calls = vc.calls.length;
      expect(
        await hints.refreshFromHint(A, ids, { fetch: vc.fetch() }),
      ).toBeNull();
      expect(vc.calls.length).toBe(calls);
    });

    it("ignores a hint for a repository of another installation", async () => {
      // project-b links to repo 22, which belongs to installation B.
      expect(
        await hints.foldDeploymentHint(
          A,
          { repository: { id: 22 } },
          new Date(),
        ),
      ).toEqual([]);
      expect(
        await hints.foldDeploymentHint(
          B,
          { repository: { id: 22 } },
          new Date(),
        ),
      ).toEqual([]);
      expect(
        await hints.foldDeploymentHint(
          A,
          { repository: { id: "x" as unknown as number } },
          new Date(),
        ),
      ).toEqual([]);
    });
  });

  describe("isolation", () => {
    beforeEach(async () => {
      await connectA();
      await sync({ force: true });
    });

    it("answers 404 for every data/vercel.ts read across tenants", async () => {
      const onlyB = actor("ADMIN", [B]).scope;
      const reads: Array<() => Promise<unknown>> = [
        () => data.getVercelSummary(onlyB, A),
        () => data.getVercelSettings(onlyB, A),
        () => data.findVercelConnection(onlyB, A),
        () =>
          data.listDeployments(onlyB, A, {
            q: undefined,
            sort: "created",
            dir: "desc",
            page: 1,
            size: 25,
            filters: [],
            range: "30d",
          }),
        () => data.getDeploymentInsights(onlyB, A, "30d"),
        () =>
          data.listVercelProjects(onlyB, A, {
            q: undefined,
            sort: "name",
            dir: "asc",
            page: 1,
            size: 25,
            filters: [],
          }),
        () => data.getRepoDeployments(onlyB, A, 11n),
        () => data.deploymentsForShas(onlyB, A, [SHA(2)]),
        () => data.listNeedsAttention(onlyB, A),
        () => data.findVercelProject(onlyB, A, "prj_testA1"),
        () => data.findLinkableRepository(onlyB, A, 11n),
      ];
      for (const read of reads)
        await expect(read()).rejects.toThrow("Not found");
      // A's own project id through B's installation: not found.
      await expect(
        data.findVercelProject(actor("ADMIN").scope, B, "prj_testA1"),
      ).rejects.toThrow("Not found");
      // B's repository through A: the repo card is absent (404), no hint.
      await expect(
        data.getRepoDeployments(actor("ADMIN").scope, A, 22n),
      ).rejects.toThrow("Not found");
      expect(await data.getHostingCards(onlyB)).toEqual([]);
      expect(await data.vercelConnectedIds(onlyB)).toEqual(new Set());
    });

    it("refuses a manual link to another installation's repository", async () => {
      const res = await mgmt.linkVercelProject(
        actor("ADMIN"),
        {
          installationId: A,
          projectId: "prj_testA2",
          repositoryId: 22n,
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      expect(res).toEqual({ status: "refused", reason: "invalid_repository" });
      const ok = await mgmt.linkVercelProject(
        actor("ADMIN"),
        {
          installationId: A,
          projectId: "prj_testA3",
          repositoryId: 11n,
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      expect(ok).toMatchObject({ status: "succeeded" });
      const audit = await db.auditLog.findFirstOrThrow({
        where: { action: "VERCEL_PROJECT_LINK", status: "SUCCEEDED" },
      });
      expect(audit).toMatchObject({
        targetType: "vercel_project",
        targetId: "prj_testA3",
        repositoryId: 11n,
        repoFullName: "example-user/repo-a",
      });
      const cards = await data.getRepoDeployments(
        actor("VIEWER").scope,
        A,
        11n,
      );
      expect(cards.map((c) => c.projectId).sort()).toEqual([
        "prj_testA1",
        "prj_testA3",
      ]);
      expect(cards.find((c) => c.projectId === "prj_testA3")!.manualLink).toBe(
        true,
      );
      // A project of another installation: 404.
      await expect(
        mgmt.linkVercelProject(
          actor("ADMIN"),
          {
            installationId: B,
            projectId: "prj_testA1",
            repositoryId: 22n,
            confirmed: true,
            idempotencyKey: randomUUID(),
          },
          deps(),
        ),
      ).rejects.toThrow("Not found");
    });

    it("shows previews per commit SHA for the PR list and the run page", async () => {
      const m = await data.deploymentsForShas(actor("VIEWER").scope, A, [
        SHA(3),
        SHA(2),
        "not-a-sha",
      ]);
      expect(m.get(SHA(3))?.[0]).toMatchObject({
        target: "preview",
        state: "READY",
        projectName: "project-a",
      });
      expect(m.get(SHA(2))?.[0]).toMatchObject({ target: "production" });
    });
  });

  describe("secrets", () => {
    it("never stores the token, env values or user names in plaintext anywhere", async () => {
      const result = await connectA();
      await sync({ force: true });
      vc.tokens.get(TOKEN_A)!.revoked = true;
      await sync();
      // Full-database grep over every table of the public schema.
      const tables = await db.$queryRaw<Array<{ tablename: string }>>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
      let dump = "";
      for (const { tablename } of tables) {
        const rows = await db.$queryRawUnsafe<Array<{ j: string }>>(
          `SELECT row_to_json(t)::text AS j FROM "${tablename}" t`,
        );
        dump += rows.map((r) => r.j).join("\n");
      }
      expect(dump.length).toBeGreaterThan(1000);
      for (const secret of [
        TOKEN_A,
        ENV_SECRET_VALUE,
        "DATABASE_PASSWORD",
        "Example Person",
        "user@example.com",
        "secret-invite",
      ])
        expect(dump).not.toContain(secret);
      expect(dump).not.toContain(TOKEN_A.slice(0, 20));
      // Logs and the action result.
      expect(logs.join("\n")).not.toContain(TOKEN_A);
      expect(JSON.stringify(result)).not.toContain(TOKEN_A);
      // Pages' DTOs.
      const settings = await data.getVercelSettings(actor("ADMIN").scope, A);
      expect(JSON.stringify(settings)).not.toContain(TOKEN_A);
      expect(settings.connection?.tokenHint).toBe("1111");
    });

    it("applies the env token without persisting it", async () => {
      const envToken = {
        token: TOKEN_A,
        teamId: TEAM_A,
        accountLogin: "example-user",
      };
      expect(
        await connect.ensureEnvConnection(B, envToken, vc.fetch(), new Date()),
      ).toBe("not_applicable");
      expect(
        await connect.ensureEnvConnection(A, envToken, vc.fetch(), new Date()),
      ).toBe("created");
      const conn = await db.vercelConnection.findUniqueOrThrow({
        where: { installationId: A },
      });
      expect(conn).toMatchObject({
        tokenSource: "ENV",
        accessToken: null,
        teamId: TEAM_A,
      });
      const r = await step.runVercelStep({
        installationId: A,
        timezone: "UTC",
        retentionDays: 90,
        deadline: new budget.Deadline(Date.now() + 60_000),
        fetch: vc.fetch(),
        envToken,
        forceProjects: true,
      });
      expect(r.status).toBe("ok");
      const raw = await db.$queryRaw<
        Array<{ j: string }>
      >`SELECT row_to_json(c)::text AS j FROM "VercelConnection" c`;
      expect(raw[0]!.j).not.toContain(TOKEN_A);
      // Without the env token: nothing to call.
      const calls = vc.calls.length;
      const none = await step.runVercelStep({
        installationId: A,
        timezone: "UTC",
        retentionDays: 90,
        deadline: new budget.Deadline(Date.now() + 60_000),
        fetch: vc.fetch(),
        envToken: null,
      });
      expect(none.status).toBe("credential_error");
      expect(vc.calls.length).toBe(calls);
    });

    it("re-encrypts tokens stored under the previous key (k2)", async () => {
      await connectA();
      const prev = createKeyRing(PREVIOUS_KEY);
      const aad = credential.vercelTokenAad(A);
      await db.vercelConnection.update({
        where: { installationId: A },
        data: { accessToken: prev.encrypt(TOKEN_A, aad) },
      });
      const res = await credential.reencryptStoredTokens(() => false);
      expect(res.reencrypted).toBe(1);
      const conn = await db.vercelConnection.findUniqueOrThrow({
        where: { installationId: A },
      });
      expect(prev.needsReencrypt(conn.accessToken!)).toBe(true);
      const cred = await credential.vercelCredentialFor(A, null);
      expect(cred).toMatchObject({ kind: "token", token: TOKEN_A });
      expect(
        (await credential.reencryptStoredTokens(() => false)).reencrypted,
      ).toBe(0);
    });
  });

  it("keeps the existing action gate behaviour (no Vercel gate in M5)", async () => {
    // A GitHub-side setting still goes through the unchanged pipeline.
    const begun = await action.beginAction(
      actor("VIEWER"),
      {
        installationId: A,
        action: "SETTINGS_UPDATE",
        role: "ADMIN",
        idempotencyKey: randomUUID(),
        target: { type: "installation", id: String(A) },
        confirmation: "DIALOG",
        requiresManagement: false,
      },
      deps(),
    );
    expect(begun.ok).toBe(false);
  });
});
