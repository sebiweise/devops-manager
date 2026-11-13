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
import type { TenantScope } from "@/server/authz/scope";
import type * as AuditData from "@/server/data/audit";
import type * as Installations from "@/server/data/installations";
import type * as VercelData from "@/server/data/vercel";
import type * as Db from "@/server/db";
import type * as Budget from "@/server/ingest/budget";
import type * as Step from "@/server/ingest/vercel-reconcile";
import type * as Management from "@/server/management/vercel";
import type * as Actions from "@/server/management/vercel-actions";
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
 * Vercel M6 (design addendum §8, §12) against a real Postgres and
 * FakeVercel: redeploy, cancel, promote and rollback through the management
 * pipeline (role matrix with DENIED rows, the three toggles independently,
 * TYPED project names, idempotency with one Vercel call, audit rows with
 * the token identity and x-vercel-id, a verified chain), the re-read after
 * each call, auto-assign paused set by a rollback and cleared by a promote,
 * the Hobby rollback limit, ambiguous outcomes linked by reconcile v7, and
 * the build log excerpt for operators (scrubbed, never stored).
 */

vi.mock("next/cache", () => ({ revalidateTag: () => undefined }));

const TOKEN_A = "vcp_testteamscopedaaaaaaaaaaaaaa1111";
const TEAM_A = "team_testAAAAAAAAAAAA";
const TEAM_B = "team_testBBBBBBBBBBBB";
const TOKEN_B = "vcp_testotherteamcccccccccccccccc3333";
const DAY = 86_400_000;
const SHA = (n: number) => n.toString(16).padStart(40, "0");
const json = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) =>
    typeof x === "bigint" ? String(x) : x,
  );

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
let mgmt: typeof Management;
let actions: typeof Actions;
let data: typeof VercelData;
let auditData: typeof AuditData;
let installations: typeof Installations;
let step: typeof Step;
let budget: typeof Budget;

describe.skipIf(!DATABASE_URL)("vercel actions (M6)", () => {
  let vc: FakeVercel;
  const logs: string[] = [];
  const base = (over: Partial<Actions.VercelActionDeps> = {}) =>
    actions.defaultVercelActionDeps({
      clients: new FakeGitHub().clients(),
      revalidate: () => undefined,
      managementEnabled: true,
      mergeAuditTrailer: false,
      vercelFetch: vc.fetch(),
      sleep: async () => undefined,
      ...over,
    });

  const sync = async () => {
    const clock = Date.now();
    return step.runVercelStep({
      installationId: A,
      timezone: "UTC",
      retentionDays: 90,
      deadline: new budget.Deadline(clock + 240_000, () => Date.now()),
      forceProjects: true,
      fetch: vc.fetch(),
      envToken: null,
    });
  };

  const act = (
    role: Role,
    deploymentId: string,
    operation: Actions.VercelOperation,
    extra: Partial<Actions.DeploymentActionInput> = {},
    deps = base(),
  ) =>
    actions.performVercelDeploymentAction(
      actor(role),
      {
        installationId: A,
        deploymentId,
        operation,
        confirmed: true,
        idempotencyKey: randomUUID(),
        ...extra,
      },
      deps,
    );

  const writes = () => vc.calls.filter((c) => c.method !== "GET");

  beforeAll(async () => {
    setActionsEnv({
      OPERATOR_EMAILS: USERS.OPERATOR.email,
      VIEWER_EMAILS: USERS.VIEWER.email,
      ADMIN_EMAILS: USERS.ADMIN.email,
    });
    ({ db } = await import("@/server/db"));
    mgmt = await import("@/server/management/vercel");
    actions = await import("@/server/management/vercel-actions");
    data = await import("@/server/data/vercel");
    auditData = await import("@/server/data/audit");
    installations = await import("@/server/data/installations");
    step = await import("@/server/ingest/vercel-reconcile");
    budget = await import("@/server/ingest/budget");
    for (const level of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(
          args
            .map((a) =>
              a instanceof Error
                ? a.message
                : typeof a === "string"
                  ? a
                  : json(a),
            )
            .join(" "),
        );
      });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await db?.$disconnect();
  });

  beforeEach(async () => {
    await resetTables(db);
    await db.$executeRawUnsafe(
      `TRUNCATE "RateLimitBucket", "Session", "Account", "User" CASCADE`,
    );
    await seedInstallations(db);
    await db.installation.updateMany({
      data: { permissionsCheckedAt: new Date(), managementEnabled: true },
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
    vc.tokens.set(TOKEN_B, { teams: [TEAM_B] });
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
        id: "prj_testB1",
        teamId: TEAM_B,
        name: "project-z",
        repoId: 22,
        repo: "example-org/repo-b",
        liveProductionId: "dpl_testB_1",
      },
    );
    const now = Date.now();
    const add = (
      uid: string,
      ageMs: number,
      state: string,
      target: "production" | null,
      sha: number,
      projectId = "prj_testA1",
    ) =>
      vc.addDeployment({
        uid,
        teamId: projectId === "prj_testB1" ? TEAM_B : TEAM_A,
        projectId,
        name: projectId === "prj_testB1" ? "project-z" : "project-a",
        createdAt: now - ageMs,
        readyState: state,
        target,
        sha: SHA(sha),
        ref: target === "production" ? "main" : "feature/x",
      });
    add("dpl_testA_p0", 70 * DAY, "READY", "production", 1);
    add("dpl_testA_p1", 60 * DAY, "READY", "production", 2);
    add("dpl_testA_p2", 2 * DAY, "READY", "production", 3);
    add("dpl_testA_v1", DAY, "READY", null, 4);
    add("dpl_testA_p3", 3_600_000, "ERROR", "production", 5);
    add("dpl_testA_b1", 60_000, "BUILDING", null, 6);
    add("dpl_testB_1", DAY, "READY", "production", 9, "prj_testB1");

    // Connect team A to installation A, team B to B, and sync A.
    for (const [inst, token] of [
      [A, TOKEN_A],
      [B, TOKEN_B],
    ] as const) {
      const res = await mgmt.connectVercel(
        actor("ADMIN"),
        {
          installationId: inst,
          token,
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        mgmt.defaultVercelDeps({
          clients: new FakeGitHub().clients(),
          revalidate: () => undefined,
          managementEnabled: true,
          mergeAuditTrailer: false,
          fetch: vc.fetch(),
          schedule: () => undefined,
        }),
      );
      expect(res.status).toBe("succeeded");
    }
    expect((await sync()).status).toBe("ok");
    vc.writes = true;
    vc.calls.length = 0;
    logs.length = 0;
  });

  afterEach(() => {
    expect(vc.decryptRequested).toBe(false);
  });

  const toggle = (enabled: boolean, role: Role = "ADMIN", typed = "team-a") =>
    actions.setVercelManagementEnabled(
      actor(role),
      { installationId: A, enabled, typed, idempotencyKey: randomUUID() },
      base(),
    );

  describe("the Vercel management toggle", () => {
    it("is off by default and needs an admin with the typed team slug", async () => {
      expect(
        (
          await db.vercelConnection.findUniqueOrThrow({
            where: { installationId: A },
          })
        ).managementEnabled,
      ).toBe(false);
      expect(await toggle(true, "OPERATOR")).toEqual({ status: "forbidden" });
      expect(await toggle(true, "ADMIN", "team-b")).toEqual({
        status: "confirmation_mismatch",
      });
      // Works while the installation's own toggle is off (local setting).
      await db.installation.update({
        where: { id: A },
        data: { managementEnabled: false },
      });
      expect(await toggle(true)).toMatchObject({
        status: "succeeded",
        data: { enabled: true },
      });
      expect(await toggle(true)).toEqual({
        status: "refused",
        reason: "unchanged",
      });
      const rows = await db.auditLog.findMany({
        where: { installationId: A, action: "VERCEL_MANAGEMENT_TOGGLE" },
        orderBy: { seq: "asc" },
      });
      expect(rows.map((r) => r.status)).toEqual(["DENIED", "SUCCEEDED"]);
      expect(rows[1]!.params).toEqual({
        teamSlug: "team-a",
        before: false,
        after: true,
      });
      expect(rows[1]!.confirmation).toBe("TYPED");
      // The global kill switch blocks the toggle as well.
      expect(
        await actions.setVercelManagementEnabled(
          actor("ADMIN"),
          {
            installationId: A,
            enabled: false,
            typed: "team-a",
            idempotencyKey: randomUUID(),
          },
          base({ managementEnabled: false }),
        ),
      ).toEqual({ status: "management_disabled", level: "global" });
    });
  });

  describe("gates", () => {
    it("answers unavailable plus a DENIED row for each closed toggle, without a Vercel call", async () => {
      // Vercel toggle off (default).
      expect(await act("OPERATOR", "dpl_testA_v1", "redeploy")).toEqual({
        status: "unavailable",
        reason: "vercel_management_disabled",
      });
      await toggle(true);
      // Installation toggle off.
      await db.installation.update({
        where: { id: A },
        data: { managementEnabled: false },
      });
      expect(await act("OPERATOR", "dpl_testA_v1", "redeploy")).toEqual({
        status: "unavailable",
        reason: "management_disabled_installation",
      });
      await db.installation.update({
        where: { id: A },
        data: { managementEnabled: true },
      });
      // Global kill switch off.
      expect(
        await act(
          "OPERATOR",
          "dpl_testA_v1",
          "redeploy",
          {},
          base({ managementEnabled: false }),
        ),
      ).toEqual({
        status: "unavailable",
        reason: "management_disabled_global",
      });
      // A revoked connection.
      await db.vercelConnection.update({
        where: { installationId: A },
        data: { revokedAt: new Date() },
      });
      expect(await act("OPERATOR", "dpl_testA_v1", "redeploy")).toEqual({
        status: "unavailable",
        reason: "vercel_revoked",
      });
      expect(writes()).toHaveLength(0);
      const denied = await db.auditLog.findMany({
        where: { installationId: A, action: "VERCEL_REDEPLOY" },
        orderBy: { seq: "asc" },
      });
      expect(denied.map((d) => [d.status, d.error])).toEqual([
        ["DENIED", "unavailable:vercel_management_disabled"],
        ["DENIED", "unavailable:management_disabled_installation"],
        ["DENIED", "unavailable:management_disabled_global"],
        ["DENIED", "unavailable:vercel_revoked"],
      ]);
      // A replayed key answers with the same denial.
      const key = denied[0]!.idempotencyKey;
      expect(
        await act("OPERATOR", "dpl_testA_v1", "redeploy", {
          idempotencyKey: key,
        }),
      ).toEqual({
        status: "unavailable",
        reason: "vercel_management_disabled",
      });
    });

    it("lets viewers see but not act: forbidden plus a DENIED row", async () => {
      await toggle(true);
      for (const op of ["redeploy", "cancel", "promote", "rollback"] as const)
        expect(
          await act("VIEWER", "dpl_testA_p1", op, { typed: "project-a" }),
        ).toEqual({ status: "forbidden" });
      expect(writes()).toHaveLength(0);
      const rows = await db.auditLog.findMany({
        where: { installationId: A, status: "DENIED" },
      });
      expect(rows.map((r) => r.action).sort()).toEqual([
        "VERCEL_CANCEL",
        "VERCEL_PROMOTE",
        "VERCEL_REDEPLOY",
        "VERCEL_ROLLBACK",
      ]);
      // The build log is for operators and admins only.
      expect(
        await actions.getBuildLogExcerpt(
          actor("VIEWER"),
          { installationId: A, deploymentId: "dpl_testA_p3" },
          base(),
        ),
      ).toEqual({ status: "forbidden" });
      expect(vc.callsTo("/v3/")).toHaveLength(0);
    });

    it("answers 404 for a deployment of another installation", async () => {
      await toggle(true);
      await expect(
        act("ADMIN", "dpl_testB_1", "redeploy"),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      await expect(
        actions.performVercelDeploymentAction(
          actor("ADMIN", [B]),
          {
            installationId: A,
            deploymentId: "dpl_testA_v1",
            operation: "redeploy",
            confirmed: true,
            idempotencyKey: randomUUID(),
          },
          base(),
        ),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      await expect(
        actions.getBuildLogExcerpt(
          actor("ADMIN"),
          { installationId: A, deploymentId: "dpl_testB_1" },
          base(),
        ),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      expect(writes()).toHaveLength(0);
      expect(
        await db.auditLog.count({
          where: { action: { in: ["VERCEL_REDEPLOY"] } },
        }),
      ).toBe(0);
    });
  });

  describe("actions", () => {
    beforeEach(async () => {
      await toggle(true);
      vc.calls.length = 0;
    });

    it("redeploys and cancels with one audit row each, x-vercel-id and a re-read", async () => {
      const re = await act("OPERATOR", "dpl_testA_v1", "redeploy", {
        withLatestCommit: true,
      });
      expect(re).toMatchObject({
        status: "succeeded",
        data: { deploymentId: "dpl_testR1", state: "QUEUED" },
      });
      const auditId = (re as { auditId: string }).auditId;
      // The POST carried the audit id; the new deployment was re-read.
      const post = writes()[0]!;
      expect(post.method).toBe("POST");
      expect(post.path).toBe("/v13/deployments");
      expect(vc.deployments.at(-1)!.meta).toEqual({
        devopsManagerAudit: auditId,
      });
      expect(vc.callsTo("/v13/deployments/dpl_testR1")).toHaveLength(1);
      const stored = await db.vercelDeployment.findUniqueOrThrow({
        where: { id: "dpl_testR1" },
      });
      expect(stored).toMatchObject({
        installationId: A,
        state: "QUEUED",
        creatorKind: "redeploy",
        auditLogId: auditId,
        auditLinkKind: "exact",
      });

      const cancel = await act("OPERATOR", "dpl_testR1", "cancel");
      expect(cancel).toMatchObject({
        status: "succeeded",
        data: { state: "CANCELED" },
      });
      expect(
        (
          await db.vercelDeployment.findUniqueOrThrow({
            where: { id: "dpl_testR1" },
          })
        ).state,
      ).toBe("CANCELED");
      // A finished deployment cannot be cancelled; nothing is sent.
      expect(await act("OPERATOR", "dpl_testR1", "cancel")).toEqual({
        status: "refused",
        reason: "not_cancelable",
      });
      expect(writes()).toHaveLength(2);

      const rows = await db.auditLog.findMany({
        where: {
          installationId: A,
          action: { in: ["VERCEL_REDEPLOY", "VERCEL_CANCEL"] },
        },
        orderBy: { seq: "asc" },
      });
      expect(rows.map((r) => [r.action, r.status])).toEqual([
        ["VERCEL_REDEPLOY", "SUCCEEDED"],
        ["VERCEL_CANCEL", "SUCCEEDED"],
      ]);
      for (const r of rows) {
        expect(r.actingAs).toBe("vercel:token:1111");
        expect(r.actorRole).toBe("OPERATOR");
        expect(r.githubRequestId).toMatch(/^fake::\d+$/);
        expect(r.httpStatus).toBe(200);
        expect(r.targetType).toBe("vercel_deployment");
        expect(r.repositoryId).toBe(11n);
        expect(r.repoFullName).toBe("example-user/repo-a");
        expect(r.confirmation).toBe("DIALOG");
        expect(json(r)).not.toContain(TOKEN_A);
      }
      expect(rows[0]!.params).toEqual({
        projectId: "prj_testA1",
        deploymentId: "dpl_testA_v1",
        target: "preview",
        withLatestCommit: true,
      });
      expect((await auditData.verifyAuditLog(actor("ADMIN").scope, A)).ok).toBe(
        true,
      );
    });

    it("needs the typed project name for production and calls Vercel once per key", async () => {
      expect(
        await act("OPERATOR", "dpl_testA_p2", "redeploy", { typed: "project" }),
      ).toEqual({ status: "confirmation_mismatch" });
      expect(writes()).toHaveLength(0);
      const key = randomUUID();
      const first = await act("OPERATOR", "dpl_testA_p2", "redeploy", {
        typed: "project-a",
        idempotencyKey: key,
      });
      expect(first.status).toBe("succeeded");
      const again = await act("OPERATOR", "dpl_testA_p2", "redeploy", {
        typed: "project-a",
        idempotencyKey: key,
      });
      expect(again).toMatchObject({ status: "succeeded", replayed: true });
      expect(writes()).toHaveLength(1);
      const body = vc.deployments.at(-1)!;
      expect(body.target).toBe("production");
      const row = await db.auditLog.findUniqueOrThrow({
        where: { idempotencyKey: key },
      });
      expect(row.confirmation).toBe("TYPED");
    });

    it("rolls back, pauses auto-assignment with a banner, and a promote clears it", async () => {
      // Hobby: only the previous production deployment (p1) is offered.
      expect(await data.rollbackCandidateIds(A, "prj_testA1", "hobby")).toEqual(
        ["dpl_testA_p1"],
      );
      expect(
        await act("OPERATOR", "dpl_testA_p0", "rollback", {
          typed: "project-a",
        }),
      ).toEqual({ status: "refused", reason: "not_rollback_candidate" });
      expect(
        await act("OPERATOR", "dpl_testA_p1", "rollback", {
          typed: "project-b",
        }),
      ).toEqual({ status: "confirmation_mismatch" });
      expect(writes()).toHaveLength(0);

      const rb = await act("OPERATOR", "dpl_testA_p1", "rollback", {
        typed: "project-a",
      });
      expect(rb).toMatchObject({
        status: "succeeded",
        data: { liveDeploymentId: "dpl_testA_p1", aliasStatus: "succeeded" },
      });
      expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual([
        "POST /v1/projects/prj_testA1/rollback/dpl_testA_p1",
      ]);
      const project = await db.vercelProject.findUniqueOrThrow({
        where: { id: "prj_testA1" },
      });
      expect(project).toMatchObject({
        liveProdDeploymentId: "dpl_testA_p1",
        aliasRequestType: "rollback",
        aliasRequestStatus: "succeeded",
      });
      expect(project.autoAssignPausedAt).not.toBeNull();
      // Banner data: repo card, project row and Needs attention offer Promote.
      const [card] = await data.getRepoDeployments(
        actor("VIEWER").scope,
        A,
        11n,
      );
      expect(card!.autoAssignPausedAt).not.toBeNull();
      expect(card!.promote?.id).toBe("dpl_testA_p2");
      const attention = await data.listNeedsAttention(actor("VIEWER").scope, A);
      const paused = attention.find((i) => i.kind === "auto_assign_paused");
      expect(paused?.promote).toEqual({
        deploymentId: "dpl_testA_p2",
        projectName: "project-a",
        commitSha: SHA(3),
      });
      // The pause survives a reconcile pass (the project list agrees).
      expect((await sync()).status).toBe("ok");
      expect(
        (
          await db.vercelProject.findUniqueOrThrow({
            where: { id: "prj_testA1" },
          })
        ).autoAssignPausedAt,
      ).not.toBeNull();

      const pr = await act("OPERATOR", "dpl_testA_p2", "promote", {
        typed: "project-a",
      });
      expect(pr).toMatchObject({
        status: "succeeded",
        data: { liveDeploymentId: "dpl_testA_p2" },
      });
      const after = await db.vercelProject.findUniqueOrThrow({
        where: { id: "prj_testA1" },
      });
      expect(after.autoAssignPausedAt).toBeNull();
      expect(after.aliasRequestType).toBe("promote");
      expect(
        (await data.listNeedsAttention(actor("VIEWER").scope, A)).some(
          (i) => i.kind === "auto_assign_paused",
        ),
      ).toBe(false);
      expect(
        (
          await db.finding.findFirstOrThrow({
            where: {
              installationId: A,
              ruleKey: "vercel:auto-assign-paused:prj_testA1",
            },
          })
        ).status,
      ).toBe("FIXED");
      // Promoting the deployment that is live and not paused is refused.
      expect(
        await act("OPERATOR", "dpl_testA_p2", "promote", {
          typed: "project-a",
        }),
      ).toEqual({ status: "refused", reason: "already_live" });
      // A failed build cannot be promoted.
      expect(
        await act("OPERATOR", "dpl_testA_p3", "promote", {
          typed: "project-a",
        }),
      ).toEqual({ status: "refused", reason: "not_promotable" });

      const rows = await db.auditLog.findMany({
        where: {
          installationId: A,
          action: { in: ["VERCEL_ROLLBACK", "VERCEL_PROMOTE"] },
        },
        orderBy: { seq: "asc" },
      });
      expect(rows.map((r) => [r.action, r.status, r.httpStatus])).toEqual([
        ["VERCEL_ROLLBACK", "SUCCEEDED", 201],
        ["VERCEL_PROMOTE", "SUCCEEDED", 202],
      ]);
      expect((await auditData.verifyAuditLog(actor("ADMIN").scope, A)).ok).toBe(
        true,
      );
    });

    it("offers every eligible older production deployment on Pro", async () => {
      await db.vercelConnection.update({
        where: { installationId: A },
        data: { plan: "pro" },
      });
      expect(await data.rollbackCandidateIds(A, "prj_testA1", "pro")).toEqual([
        "dpl_testA_p1",
        "dpl_testA_p0",
      ]);
      // Vercel itself still enforces its plan (the fake team is on Hobby).
      const res = await act("OPERATOR", "dpl_testA_p0", "rollback", {
        typed: "project-a",
      });
      expect(res).toMatchObject({ status: "failed", httpStatus: 402 });
      expect((res as { message: string }).message).toMatch(/^plan_limit: /);
      const row = await db.auditLog.findFirstOrThrow({
        where: { installationId: A, action: "VERCEL_ROLLBACK" },
      });
      expect(row).toMatchObject({ status: "FAILED", httpStatus: 402 });
      expect(row.githubRequestId).toMatch(/^fake::/);
    });

    it("links a redeploy whose outcome is unknown to the deployment it created", async () => {
      vc.dropAfterSend.push("/v13/deployments");
      const res = await act("OPERATOR", "dpl_testA_v1", "redeploy");
      expect(res).toMatchObject({ status: "failed", httpStatus: null });
      expect((res as { message: string }).message).toMatch(
        /^outcome_unknown: /,
      );
      const auditId = (res as { auditId: string }).auditId;
      // The deployment exists at Vercel; reconcile links it through meta.
      expect(
        await db.vercelDeployment.count({ where: { id: "dpl_testR1" } }),
      ).toBe(0);
      expect((await sync()).status).toBe("ok");
      const linked = await db.vercelDeployment.findUniqueOrThrow({
        where: { id: "dpl_testR1" },
      });
      expect(linked).toMatchObject({
        auditLogId: auditId,
        auditLinkKind: "exact",
      });
      // The audit row is never rewritten.
      const row = await db.auditLog.findUniqueOrThrow({
        where: { id: auditId },
      });
      expect(row.status).toBe("FAILED");
      const listed = await data.listDeployments(actor("VIEWER").scope, A, {
        range: "30d",
        q: undefined,
        sort: "created",
        dir: "desc",
        page: 1,
        size: 50,
        filters: [],
      });
      expect(listed.rows.find((d) => d.id === "dpl_testR1")).toMatchObject({
        auditEntryId: auditId,
        auditLinkKind: "exact",
      });
    });

    it("falls back to a probable link when Vercel does not echo meta", async () => {
      vc.echoMeta = false;
      vc.dropAfterSend.push("/v13/deployments");
      const res = await act("OPERATOR", "dpl_testA_v1", "redeploy");
      const auditId = (res as { auditId: string }).auditId;
      expect((await sync()).status).toBe("ok");
      expect(
        await db.vercelDeployment.findUniqueOrThrow({
          where: { id: "dpl_testR1" },
        }),
      ).toMatchObject({ auditLogId: auditId, auditLinkKind: "probable" });
      // A meta id of another installation's row is never linked.
      expect(await step.linkProbableRedeploys(A, new Date())).toBe(0);
    });

    it("keeps an accepted rollback or promote when the project re-read fails", async () => {
      // Vercel accepts the rollback, then the project GET answers 503.
      vc.failNext("/v9/projects/prj_testA1", 503, {
        error: { code: "internal_error", message: "try again" },
      });
      const rb = await act("OPERATOR", "dpl_testA_p1", "rollback", {
        typed: "project-a",
      });
      expect(rb).toMatchObject({
        status: "succeeded",
        data: { deploymentId: "dpl_testA_p1", liveDeploymentId: null },
      });
      expect(vc.projects[0]!.liveProductionId).toBe("dpl_testA_p1");
      const project = await db.vercelProject.findUniqueOrThrow({
        where: { id: "prj_testA1" },
      });
      expect(project).toMatchObject({
        aliasRequestType: "rollback",
        aliasToDeploymentId: "dpl_testA_p1",
      });
      expect(project.autoAssignPausedAt).not.toBeNull();
      expect(project.dirtyAt).not.toBeNull();
      expect(
        (await data.listNeedsAttention(actor("VIEWER").scope, A)).map(
          (i) => i.kind,
        ),
      ).toContain("auto_assign_paused");
      // The next pass reads the project and keeps the pause.
      expect((await sync()).status).toBe("ok");
      expect(
        (
          await db.vercelProject.findUniqueOrThrow({
            where: { id: "prj_testA1" },
          })
        ).liveProdDeploymentId,
      ).toBe("dpl_testA_p1");

      // A promote whose re-read hits a 429 still ends the pause.
      vc.failNext(
        "/v9/projects/prj_testA1",
        429,
        { error: { code: "rate_limited", message: "slow down" } },
        { "retry-after": "60" },
      );
      const pr = await act("OPERATOR", "dpl_testA_p2", "promote", {
        typed: "project-a",
      });
      expect(pr).toMatchObject({ status: "succeeded" });
      const after = await db.vercelProject.findUniqueOrThrow({
        where: { id: "prj_testA1" },
      });
      expect(after.autoAssignPausedAt).toBeNull();
      expect(after.aliasRequestType).toBe("promote");
      const rows = await db.auditLog.findMany({
        where: {
          installationId: A,
          action: { in: ["VERCEL_ROLLBACK", "VERCEL_PROMOTE"] },
        },
        orderBy: { seq: "asc" },
      });
      expect(
        rows.map((r) => [
          r.action,
          r.status,
          r.httpStatus,
          !!r.githubRequestId,
        ]),
      ).toEqual([
        ["VERCEL_ROLLBACK", "SUCCEEDED", 201, true],
        ["VERCEL_PROMOTE", "SUCCEEDED", 202, true],
      ]);
    });

    it("marks the connection revoked when Vercel rejects the token during an action", async () => {
      vc.tokens.get(TOKEN_A)!.revoked = true;
      const res = await act("OPERATOR", "dpl_testA_v1", "redeploy");
      expect(res).toMatchObject({ status: "failed", httpStatus: 401 });
      const conn = await db.vercelConnection.findUniqueOrThrow({
        where: { installationId: A },
      });
      expect(conn.revokedAt).not.toBeNull();
      expect(conn.lastSyncStatus).toBe("credential_error");
      expect(await act("OPERATOR", "dpl_testA_v1", "redeploy")).toEqual({
        status: "unavailable",
        reason: "vercel_revoked",
      });
    });
  });

  describe("build log excerpt", () => {
    it("revokes on a rejected token and pauses the sync on a 429", async () => {
      vc.failNext("/v3/deployments/dpl_testA_p3/events", 429, {
        error: {
          code: "rate_limited",
          message: "slow down",
          limit: { resetMs: Date.now() + 120_000 },
        },
      });
      const limited = await actions.getBuildLogExcerpt(
        actor("OPERATOR"),
        { installationId: A, deploymentId: "dpl_testA_p3" },
        base(),
      );
      expect(limited).toMatchObject({ status: "failed", httpStatus: 429 });
      const paused = await db.vercelConnection.findUniqueOrThrow({
        where: { installationId: A },
      });
      expect(paused.pausedUntil!.getTime()).toBeGreaterThan(
        Date.now() + 60_000,
      );
      expect(paused.revokedAt).toBeNull();

      vc.tokens.get(TOKEN_A)!.revoked = true;
      const rejected = await actions.getBuildLogExcerpt(
        actor("OPERATOR"),
        { installationId: A, deploymentId: "dpl_testA_p3" },
        base(),
      );
      expect(rejected).toMatchObject({ status: "failed", httpStatus: 401 });
      expect(json(rejected)).not.toContain(TOKEN_A);
      expect(
        (
          await db.vercelConnection.findUniqueOrThrow({
            where: { installationId: A },
          })
        ).revokedAt,
      ).not.toBeNull();
      expect(
        (await data.listNeedsAttention(actor("VIEWER").scope, A)).map(
          (i) => i.kind,
        ),
      ).toContain("credential_revoked");
    });

    it("is fetched live for operators, scrubbed, capped and never stored", async () => {
      vc.logs.set("dpl_testA_p3", [
        {
          type: "command",
          created: 1,
          payload: { text: "pnpm build", date: 1 },
        },
        {
          type: "stdout",
          created: 2,
          payload: {
            text: `using token ${TOKEN_A} for build-marker-0001`,
            date: 2,
          },
        },
        {
          type: "stderr",
          created: 3,
          payload: {
            text: "Error: Authorization: Bearer abc.def.ghi failed",
            date: 3,
          },
        },
        { type: "delimiter", created: 4, payload: { text: "", date: 4 } },
      ]);
      const res = await actions.getBuildLogExcerpt(
        actor("OPERATOR"),
        { installationId: A, deploymentId: "dpl_testA_p3" },
        base(),
      );
      expect(res.status).toBe("ok");
      const ok = res as Extract<Actions.BuildLogResult, { status: "ok" }>;
      expect(ok.excerpt.lines.map((l) => [l.stream, l.text])).toEqual([
        ["cmd", "pnpm build"],
        ["out", "using token [redacted] for build-marker-0001"],
        ["err", "Error: Authorization: [redacted] [redacted] failed"],
      ]);
      expect(ok.vercelUrl).toBe("https://vercel.com/team-a/project-a/testA_p3");
      expect(json(res)).not.toContain(TOKEN_A);
      // Nothing of it reaches the database or the logs; no write was sent.
      const tables = await db.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
      for (const t of tables) {
        const rows = await db.$queryRawUnsafe<Array<{ j: string }>>(
          `SELECT row_to_json(x)::text AS j FROM "${t.table_name}" x`,
        );
        for (const r of rows) {
          expect(r.j).not.toContain("build-marker-0001");
          expect(r.j).not.toContain(TOKEN_A);
          expect(r.j).not.toContain(ENV_SECRET_VALUE);
        }
      }
      expect(logs.join("\n")).not.toContain("build-marker-0001");
      expect(writes()).toHaveLength(0);
    });
  });
});
