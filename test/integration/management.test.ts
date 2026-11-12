import { randomUUID } from "node:crypto";
import {
  afterAll,
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
import type * as Dependabot from "@/server/data/dependabot";
import type * as Installations from "@/server/data/installations";
import type * as ManagementData from "@/server/data/management";
import type * as PullsData from "@/server/data/pulls";
import type * as VariablesData from "@/server/data/variables";
import type * as Db from "@/server/db";
import type * as Pulls from "@/server/management/pulls";
import type * as Runs from "@/server/management/runs";
import type * as Settings from "@/server/management/settings";
import type * as Variables from "@/server/management/variables";
import {
  A,
  B,
  DATABASE_URL,
  resetTables,
  seedInstallations,
  setActionsEnv,
} from "./support/actions";
import { FakeManagedGitHub, type FakeRepo } from "./support/management";

/**
 * The management pipeline and actions against a real Postgres and an
 * in-memory GitHub that enforces token permissions and repo narrowing
 * (design §8, §12, M3 acceptance criteria): role matrix with DENIED rows,
 * 404 for foreign ids, kill switch and per-installation toggle, idempotency,
 * purpose-narrowed tokens, the audit hash chain with tamper detection, the
 * LINUX_RUNNER preset bulk set with preview and revert, merge guards and
 * workflow merges, rate limit, and installation isolation of the reads.
 */

vi.mock("next/cache", () => ({ revalidateTag: () => undefined }));

const FULL = {
  metadata: "read",
  actions: "write",
  contents: "write",
  pull_requests: "write",
  workflows: "write",
  checks: "read",
  statuses: "read",
  actions_variables: "write",
  vulnerability_alerts: "read",
  organization_actions_variables: "write",
};

type Role = TenantScope["role"];

const USERS: Record<Role, { id: string; email: string }> = {
  VIEWER: { id: "user-viewer", email: "viewer@example.com" },
  OPERATOR: { id: "user-operator", email: "operator@example.com" },
  ADMIN: { id: "user-admin", email: "admin@example.com" },
};

/** An address the env assigns OPERATOR, for the "lowered role" case. */
const SECOND_OPERATOR = "operator-2@example.com";

const BULK_REPOS = Array.from({ length: 10 }, (_, i) => ({
  id: 101 + i,
  name: `repo-${i + 1}`,
}));

const RUN_A = 5001n; // completed run in example-user/repo-a
const RUN_B = 5002n; // run of the org installation
const RUN_A_LIVE = 5003n; // in-progress run in example-user/repo-a

let db: typeof Db.db;
let action: typeof ActionModule;
let runs: typeof Runs;
let variables: typeof Variables;
let pulls: typeof Pulls;
let settings: typeof Settings;
let auditData: typeof AuditData;
let managementData: typeof ManagementData;
let variablesData: typeof VariablesData;
let pullsData: typeof PullsData;
let dependabot: typeof Dependabot;
let installations: typeof Installations;

const key = () => randomUUID();

function actor(role: Role, installationIds: bigint[] = [A, B]) {
  const u = USERS[role];
  return {
    user: { id: u.id, name: role.toLowerCase(), email: u.email },
    scope: { userId: u.id, role, installationIds },
    ipHash: "a".repeat(64),
    userAgent: "vitest",
  };
}

describe.skipIf(!DATABASE_URL)("management", () => {
  let gh: FakeManagedGitHub;
  const deps = (over: Partial<ActionModule.ActionDeps> = {}) =>
    action.defaultActionDeps({
      clients: gh.clients(),
      revalidate: () => undefined,
      managementEnabled: true,
      mergeAuditTrailer: false,
      ...over,
    });

  beforeAll(async () => {
    setActionsEnv({
      OPERATOR_EMAILS: `${USERS.OPERATOR.email},${SECOND_OPERATOR}`,
      VIEWER_EMAILS: USERS.VIEWER.email,
      ADMIN_EMAILS: USERS.ADMIN.email,
    });
    ({ db } = await import("@/server/db"));
    action = await import("@/server/authz/action");
    runs = await import("@/server/management/runs");
    variables = await import("@/server/management/variables");
    pulls = await import("@/server/management/pulls");
    settings = await import("@/server/management/settings");
    auditData = await import("@/server/data/audit");
    managementData = await import("@/server/data/management");
    variablesData = await import("@/server/data/variables");
    pullsData = await import("@/server/data/pulls");
    dependabot = await import("@/server/data/dependabot");
    installations = await import("@/server/data/installations");
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    variablesData.resetVariablesCache();
    pullsData.resetPullsCache();
    dependabot.resetDependabotCache();
    await resetTables(db);
    await db.$executeRawUnsafe(
      `TRUNCATE "RateLimitBucket", "Session", "Account", "User" CASCADE`,
    );
    await seedInstallations(db, { permissions: FULL });
    await db.installation.updateMany({
      data: { managementEnabled: true, permissionsCheckedAt: new Date() },
    });
    await db.repository.createMany({
      data: BULK_REPOS.map((r) => ({
        id: BigInt(r.id),
        installationId: A,
        ownerLogin: "example-user",
        name: r.name,
        fullName: `example-user/${r.name}`,
        private: false,
      })),
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
    const now = new Date();
    const run = (
      id: bigint,
      installationId: bigint,
      repositoryId: bigint,
      status: "COMPLETED" | "IN_PROGRESS",
    ) => ({
      id,
      installationId,
      repositoryId,
      workflowName: "CI",
      headSha: "a".repeat(40),
      runNumber: 7,
      status,
      statusRank: status === "COMPLETED" ? 4 : 3,
      conclusion: status === "COMPLETED" ? ("FAILURE" as const) : null,
      createdAt: now,
      source: "WEBHOOK" as const,
      lastEventAt: now,
    });
    await db.workflowRun.createMany({
      data: [
        run(RUN_A, A, 11n, "COMPLETED"),
        run(RUN_B, B, 22n, "COMPLETED"),
        run(RUN_A_LIVE, A, 11n, "IN_PROGRESS"),
      ],
    });

    const repos: FakeRepo[] = [
      { installationId: A, id: 11, owner: "example-user", name: "repo-a" },
      { installationId: B, id: 22, owner: "example-org", name: "repo-b" },
      ...BULK_REPOS.map((r) => ({
        installationId: A,
        id: r.id,
        owner: "example-user",
        name: r.name,
      })),
    ];
    gh = new FakeManagedGitHub(repos);
    gh.runs.set(Number(RUN_A), {
      repoId: 11,
      status: "completed",
      conclusion: "failure",
      attempt: 1,
    });
    gh.runs.set(Number(RUN_B), {
      repoId: 22,
      status: "completed",
      conclusion: "failure",
      attempt: 1,
    });
    gh.runs.set(Number(RUN_A_LIVE), {
      repoId: 11,
      status: "in_progress",
      conclusion: null,
      attempt: 1,
    });
  });

  const rerun = (role: Role, idempotencyKey = key(), runId = RUN_A) =>
    runs.performRunAction(
      actor(role),
      {
        installationId: A,
        runId,
        operation: "rerun",
        confirmed: true,
        idempotencyKey,
      },
      deps(),
    );

  const setVar = (role: Role, value = "self-hosted", repositoryId = 11n) =>
    variables.setRepoVariable(
      actor(role),
      {
        installationId: A,
        repositoryId,
        name: "LINUX_RUNNER",
        value,
        confirmed: true,
        idempotencyKey: key(),
      },
      deps(),
    );

  const merge = (
    role: Role,
    over: Partial<Pulls.MergeInput> = {},
    d: ActionModule.ActionDeps = deps(),
  ) =>
    pulls.mergePullRequest(
      actor(role),
      {
        installationId: A,
        repositoryId: 11n,
        number: 1,
        sha: "b".repeat(40),
        method: "squash",
        confirmed: true,
        idempotencyKey: key(),
        ...over,
      },
      d,
    );

  const auditRows = () => db.auditLog.findMany({ orderBy: { seq: "asc" } });

  describe("role matrix", () => {
    it("a viewer cannot re-run: 403 and a DENIED audit row, no token", async () => {
      expect(await rerun("VIEWER")).toEqual({ status: "forbidden" });
      const [row] = await auditRows();
      expect(row).toMatchObject({
        status: "DENIED",
        action: "RUN_RERUN",
        actorUserId: USERS.VIEWER.id,
        actorRole: "VIEWER",
        actingAs: null,
        targetType: "run",
        targetId: String(RUN_A),
      });
      expect(gh.tokens).toHaveLength(0);
    });

    it("rate-limits denials before they are recorded", async () => {
      for (let i = 0; i < 30; i++)
        expect(await rerun("VIEWER")).toEqual({ status: "forbidden" });
      expect(await rerun("VIEWER")).toMatchObject({ status: "rate_limited" });
      expect(await db.auditLog.count()).toBe(30);
    });

    it("an operator can re-run and cancel but cannot change variables or merge", async () => {
      gh.addPull({ repoId: 11, number: 1 });
      expect((await rerun("OPERATOR")).status).toBe("succeeded");
      const cancel = await runs.performRunAction(
        actor("OPERATOR"),
        {
          installationId: A,
          runId: RUN_A_LIVE,
          operation: "cancel",
          confirmed: true,
          idempotencyKey: key(),
        },
        deps(),
      );
      expect(cancel.status).toBe("succeeded");
      expect(await setVar("OPERATOR")).toEqual({ status: "forbidden" });
      expect(await merge("OPERATOR")).toEqual({ status: "forbidden" });
      const bulk = await variables.bulkSetVariable(
        actor("OPERATOR"),
        {
          installationId: A,
          name: "LINUX_RUNNER",
          value: "self-hosted",
          repositoryIds: [11n],
          typed: "LINUX_RUNNER",
          idempotencyKey: key(),
        },
        deps(),
      );
      expect(bulk).toEqual({ status: "forbidden" });
      const rows = await auditRows();
      expect(rows.map((r) => [r.action, r.status])).toEqual([
        ["RUN_RERUN", "SUCCEEDED"],
        ["RUN_CANCEL", "SUCCEEDED"],
        ["VAR_UPDATE", "DENIED"],
        ["PR_MERGE", "DENIED"],
        ["VAR_BULK", "DENIED"],
      ]);
      expect(gh.variable(11, "LINUX_RUNNER")).toBeNull();
      expect(gh.pulls.get("11#1")!.merged).toBe(false);
    });

    it("an admin can do all of it", async () => {
      gh.addPull({ repoId: 11, number: 1 });
      expect((await rerun("ADMIN")).status).toBe("succeeded");
      expect(await setVar("ADMIN")).toMatchObject({
        status: "succeeded",
        data: { before: null, after: "self-hosted" },
      });
      expect(await merge("ADMIN")).toMatchObject({
        status: "succeeded",
        data: { merged: true, workflowsTouched: false },
      });
      expect(
        (await auditRows()).map((r) => [r.action, r.status, r.actorRole]),
      ).toEqual([
        ["RUN_RERUN", "SUCCEEDED", "ADMIN"],
        ["VAR_CREATE", "SUCCEEDED", "ADMIN"],
        ["PR_MERGE", "SUCCEEDED", "ADMIN"],
      ]);
    });

    it("re-resolves the role per action instead of trusting the session", async () => {
      // The session still says ADMIN, but the env no longer assigns a role.
      await db.user.update({
        where: { id: USERS.ADMIN.id },
        data: { email: "former-admin@example.com" },
      });
      await db.session.create({
        data: {
          id: "s1",
          token: "session-token",
          userId: USERS.ADMIN.id,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      expect(await rerun("ADMIN")).toEqual({ status: "unauthorized" });
      expect(await db.session.count()).toBe(0);
      expect(gh.tokens).toHaveLength(0);

      // A lowered role (env says operator) is denied an admin action.
      await db.user.update({
        where: { id: USERS.ADMIN.id },
        data: { email: SECOND_OPERATOR },
      });
      expect(await setVar("ADMIN")).toEqual({ status: "forbidden" });
      const denied = await db.auditLog.findFirstOrThrow({
        where: { status: "DENIED" },
      });
      expect(denied.actorRole).toBe("OPERATOR");
    });
  });

  describe("tenancy", () => {
    it("a cross-installation id answers 404 before any token or audit row", async () => {
      const onlyA = actor("ADMIN", [A]);
      await expect(
        runs.performRunAction(
          onlyA,
          {
            installationId: A,
            runId: RUN_B,
            operation: "rerun",
            confirmed: true,
            idempotencyKey: key(),
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      await expect(
        runs.performRunAction(
          onlyA,
          {
            installationId: B,
            runId: RUN_B,
            operation: "rerun",
            confirmed: true,
            idempotencyKey: key(),
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      await expect(
        variables.setRepoVariable(
          onlyA,
          {
            installationId: A,
            repositoryId: 22n,
            name: "LINUX_RUNNER",
            value: "x",
            confirmed: true,
            idempotencyKey: key(),
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      await expect(
        variables.bulkSetVariable(
          onlyA,
          {
            installationId: A,
            name: "LINUX_RUNNER",
            value: "x",
            repositoryIds: [11n, 22n],
            typed: "LINUX_RUNNER",
            idempotencyKey: key(),
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      await expect(
        pulls.mergePullRequest(
          onlyA,
          {
            installationId: A,
            repositoryId: 22n,
            number: 1,
            sha: "b".repeat(40),
            method: "merge",
            confirmed: true,
            idempotencyKey: key(),
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      await expect(
        settings.setManagementEnabled(
          onlyA,
          {
            installationId: B,
            enabled: false,
            confirmed: true,
            idempotencyKey: key(),
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      expect(gh.tokens).toHaveLength(0);
      expect(await db.auditLog.count()).toBe(0);
    });

    it("actions on one installation mint tokens for that installation only", async () => {
      await rerun("ADMIN");
      await setVar("ADMIN");
      await runs.performRunAction(
        actor("ADMIN"),
        {
          installationId: B,
          runId: RUN_B,
          operation: "rerun",
          confirmed: true,
          idempotencyKey: key(),
        },
        deps(),
      );
      expect(
        gh.tokens.map((t) => [String(t.installationId), t.purpose, t.repoIds]),
      ).toEqual([
        [String(A), "act.runs", [11]],
        [String(A), "read.variables", [11]],
        [String(A), "act.variables", [11]],
        [String(B), "act.runs", [22]],
      ]);
    });

    it("data reads with a one-installation scope hide the other installation", async () => {
      const onlyA = actor("ADMIN", [A]).scope;
      for (const read of [
        () => variablesData.listVariableMatrix(onlyA, B, gh.clients()),
        () => pullsData.listOpenPulls(onlyA, B, gh.clients()),
        () => dependabot.listDependabotAlerts(onlyA, B, gh.clients()),
        () => auditData.listAuditEntries(onlyA, B),
        () => auditData.verifyAuditLog(onlyA, B),
        () => auditData.auditCsv(onlyA, B),
        () => auditData.listVariableBatches(onlyA, B),
        () => managementData.getManagementState(onlyA, B),
      ])
        await expect(read()).rejects.toBeInstanceOf(
          installations.NotFoundError,
        );
      expect(gh.tokens).toHaveLength(0);
    });
  });

  describe("gates", () => {
    it("the global kill switch makes every action answer 403, even called directly", async () => {
      const off = deps({ managementEnabled: false });
      const results = [
        await runs.performRunAction(
          actor("ADMIN"),
          {
            installationId: A,
            runId: RUN_A,
            operation: "rerun",
            confirmed: true,
            idempotencyKey: key(),
          },
          off,
        ),
        await variables.setRepoVariable(
          actor("ADMIN"),
          {
            installationId: A,
            repositoryId: 11n,
            name: "LINUX_RUNNER",
            value: "x",
            confirmed: true,
            idempotencyKey: key(),
          },
          off,
        ),
        await merge("ADMIN", {}, off),
        await settings.setManagementEnabled(
          actor("ADMIN"),
          {
            installationId: A,
            enabled: false,
            confirmed: true,
            idempotencyKey: key(),
          },
          off,
        ),
      ];
      for (const r of results)
        expect(r).toEqual({ status: "management_disabled", level: "global" });
      expect(gh.requests).toHaveLength(0);
      expect(await db.auditLog.count()).toBe(0);
    });

    it("the per-installation toggle blocks actions until an admin turns it on", async () => {
      await db.installation.update({
        where: { id: A },
        data: { managementEnabled: false },
      });
      expect(await rerun("ADMIN")).toEqual({
        status: "management_disabled",
        level: "installation",
      });
      expect(gh.requests).toHaveLength(0);
      const toggle = (role: Role) =>
        settings.setManagementEnabled(
          actor(role),
          {
            installationId: A,
            enabled: true,
            confirmed: true,
            idempotencyKey: key(),
          },
          deps(),
        );
      expect(await toggle("OPERATOR")).toEqual({ status: "forbidden" });
      expect(await toggle("ADMIN")).toMatchObject({
        status: "succeeded",
        data: { enabled: true },
      });
      expect((await rerun("ADMIN")).status).toBe("succeeded");
      const rows = await auditRows();
      expect(rows.map((r) => [r.action, r.status, r.actingAs])).toEqual([
        ["MANAGEMENT_TOGGLE", "DENIED", null],
        ["MANAGEMENT_TOGGLE", "SUCCEEDED", null],
        ["RUN_RERUN", "SUCCEEDED", "app:example-devops-manager[bot]"],
      ]);
      expect(rows[1]!.params).toEqual({
        setting: "managementEnabled",
        before: false,
        after: true,
      });
    });

    it("refuses a missing confirmation and a wrong typed name without a GitHub write", async () => {
      expect(
        await runs.performRunAction(
          actor("ADMIN"),
          {
            installationId: A,
            runId: RUN_A,
            operation: "rerun",
            confirmed: false,
            idempotencyKey: key(),
          },
          deps(),
        ),
      ).toEqual({ status: "confirmation_mismatch" });
      gh.setVariable(11, "LINUX_RUNNER", "ubuntu-latest");
      expect(
        await variables.deleteRepoVariable(
          actor("ADMIN"),
          {
            installationId: A,
            repositoryId: 11n,
            name: "LINUX_RUNNER",
            typed: "linux_runner",
            idempotencyKey: key(),
          },
          deps(),
        ),
      ).toEqual({ status: "confirmation_mismatch" });
      expect(gh.writes()).toHaveLength(0);
      expect(gh.variable(11, "LINUX_RUNNER")).toBe("ubuntu-latest");
    });

    it("rate-limits mutations per user (30 per minute)", async () => {
      await db.rateLimitBucket.create({
        data: {
          key: `action:${USERS.ADMIN.id}`,
          tokens: 0.2,
          updatedAt: new Date(),
        },
      });
      const limited = await rerun("ADMIN");
      expect(limited).toMatchObject({ status: "rate_limited" });
      expect(
        (limited as { retryAfterS: number }).retryAfterS,
      ).toBeGreaterThanOrEqual(1);
      expect(gh.requests).toHaveLength(0);
      // Another user has their own bucket.
      expect((await rerun("OPERATOR")).status).toBe("succeeded");
    });

    it("answers 'permission not granted' without calling GitHub, refreshing stale permissions first", async () => {
      await db.installation.update({
        where: { id: A },
        data: {
          permissions: { ...FULL, actions: "read" },
          permissionsCheckedAt: new Date(Date.now() - 11 * 60_000),
        },
      });
      gh.appPermissions.set(A, { ...FULL, actions: "read" });
      expect(await rerun("ADMIN")).toEqual({
        status: "permission_not_granted",
        missing: ["actions:write"],
      });
      expect(gh.tokens).toHaveLength(0);
      expect(gh.requests.map((r) => r.route)).toEqual([
        "GET /app/installations/{installation_id}",
      ]);

      // The permission is granted on GitHub now: the next refresh picks it up.
      gh.appPermissions.set(A, FULL);
      await db.installation.update({
        where: { id: A },
        data: { permissionsCheckedAt: new Date(Date.now() - 11 * 60_000) },
      });
      expect((await rerun("ADMIN")).status).toBe("succeeded");
      const inst = await db.installation.findUniqueOrThrow({
        where: { id: A },
      });
      expect((inst.permissions as Record<string, string>).actions).toBe(
        "write",
      );
    });
  });

  describe("idempotency", () => {
    it("a double submit with the same key performs a single GitHub call", async () => {
      const k = key();
      const first = await rerun("OPERATOR", k);
      const second = await rerun("OPERATOR", k);
      expect(first).toMatchObject({ status: "succeeded", replayed: false });
      expect(second).toMatchObject({
        status: "succeeded",
        replayed: true,
        auditId: (first as { auditId: string }).auditId,
      });
      expect(gh.writes()).toHaveLength(1);
    });

    it("concurrent submits with the same key still call GitHub once", async () => {
      const k = key();
      const results = await Promise.all([
        rerun("OPERATOR", k),
        rerun("OPERATOR", k),
        rerun("OPERATOR", k),
      ]);
      expect(gh.writes()).toHaveLength(1);
      expect(results.filter((r) => r.status === "succeeded")).not.toHaveLength(
        0,
      );
      expect(
        results.every((r) => ["succeeded", "pending"].includes(r.status)),
      ).toBe(true);
      expect(await db.auditLog.count()).toBe(1);
    });

    it("a key of another user is a conflict, not a replay", async () => {
      const k = key();
      await rerun("OPERATOR", k);
      expect(await rerun("ADMIN", k)).toEqual({ status: "conflict" });
      expect(gh.writes()).toHaveLength(1);
    });

    it("replays a failure with GitHub's message", async () => {
      const k = key();
      const first = await runs.performRunAction(
        actor("OPERATOR"),
        {
          installationId: A,
          runId: RUN_A,
          operation: "cancel",
          confirmed: true,
          idempotencyKey: k,
        },
        deps(),
      );
      expect(first).toMatchObject({
        status: "failed",
        httpStatus: 409,
        message: "Cannot cancel a workflow run that is completed.",
      });
      const again = await runs.performRunAction(
        actor("OPERATOR"),
        {
          installationId: A,
          runId: RUN_A,
          operation: "cancel",
          confirmed: true,
          idempotencyKey: k,
        },
        deps(),
      );
      expect(again).toMatchObject({
        status: "failed",
        replayed: true,
        httpStatus: 409,
        message: "Cannot cancel a workflow run that is completed.",
      });
      expect(gh.writes()).toHaveLength(1);
    });
  });

  describe("runs", () => {
    it("records the app user, role, provider and the App as actor; narrows the token", async () => {
      const res = await rerun("OPERATOR");
      expect(res).toMatchObject({
        status: "succeeded",
        data: { status: "queued", runAttempt: 2 },
      });
      const row = await db.auditLog.findFirstOrThrow();
      expect(row).toMatchObject({
        action: "RUN_RERUN",
        status: "SUCCEEDED",
        actorUserId: USERS.OPERATOR.id,
        actorDisplay: "operator",
        actorRole: "OPERATOR",
        actorProvider: "oidc",
        actingAs: "app:example-devops-manager[bot]",
        repositoryId: 11n,
        repoFullName: "example-user/repo-a",
        confirmation: "DIALOG",
        httpStatus: 201,
        ipHash: "a".repeat(64),
      });
      expect(row.githubRequestId).toMatch(/^REQ-/);
      expect(row.params).toEqual({
        workflowName: "CI",
        runNumber: 7,
        runAttempt: 1,
        enableDebugLogging: false,
      });
      expect(gh.tokens).toEqual([
        {
          installationId: A,
          purpose: "act.runs",
          permissions: { actions: "write" },
          repoIds: [11],
        },
      ]);
      // No optimistic DB write: the stored run is unchanged until a webhook.
      const stored = await db.workflowRun.findUniqueOrThrow({
        where: { id: RUN_A },
      });
      expect(stored.runAttempt).toBe(1);
    });

    it("refuses a re-run at attempt 50", async () => {
      await db.workflowRun.update({
        where: { id: RUN_A },
        data: { runAttempt: 50 },
      });
      expect(await rerun("OPERATOR")).toMatchObject({
        status: "refused",
        reason: "attempt_limit",
      });
      expect(gh.writes()).toHaveLength(0);
    });

    it("offers force cancel only 60 s after a successful cancel", async () => {
      let now = Date.now();
      const clock = deps({ now: () => new Date(now) });
      const op = (operation: "cancel" | "force_cancel") =>
        runs.performRunAction(
          actor("OPERATOR"),
          {
            installationId: A,
            runId: RUN_A_LIVE,
            operation,
            confirmed: true,
            idempotencyKey: key(),
          },
          clock,
        );
      expect(await op("force_cancel")).toMatchObject({
        status: "refused",
        reason: "cancel_first",
      });
      expect((await op("cancel")).status).toBe("succeeded");
      expect(await op("force_cancel")).toMatchObject({
        status: "refused",
        reason: "force_cancel_too_early",
      });
      now += 61_000;
      expect(await op("force_cancel")).toMatchObject({
        status: "succeeded",
        data: { status: "completed", conclusion: "cancelled" },
      });
      expect(gh.writes().map((w) => w.route.split("/").pop())).toEqual([
        "cancel",
        "force-cancel",
      ]);
    });
  });

  describe("variables", () => {
    it("updates with a diff, refuses a stale preview, deletes with the typed name", async () => {
      gh.setVariable(11, "LINUX_RUNNER", "ubuntu-latest");
      const stale = await variables.setRepoVariable(
        actor("ADMIN"),
        {
          installationId: A,
          repositoryId: 11n,
          name: "LINUX_RUNNER",
          value: "self-hosted",
          expectedBefore: null,
          confirmed: true,
          idempotencyKey: key(),
        },
        deps(),
      );
      expect(stale).toMatchObject({
        status: "refused",
        reason: "stale_preview",
        detail: { current: "ubuntu-latest" },
      });
      expect(await setVar("ADMIN", "self-hosted")).toMatchObject({
        status: "succeeded",
        data: { before: "ubuntu-latest", after: "self-hosted" },
      });
      const del = await variables.deleteRepoVariable(
        actor("ADMIN"),
        {
          installationId: A,
          repositoryId: 11n,
          name: "LINUX_RUNNER",
          typed: "LINUX_RUNNER",
          idempotencyKey: key(),
        },
        deps(),
      );
      expect(del.status).toBe("succeeded");
      expect(gh.variable(11, "LINUX_RUNNER")).toBeNull();
      const rows = await auditRows();
      expect(rows.map((r) => [r.action, r.confirmation, r.params])).toEqual([
        [
          "VAR_UPDATE",
          "DIALOG",
          {
            name: "LINUX_RUNNER",
            before: "ubuntu-latest",
            after: "self-hosted",
          },
        ],
        [
          "VAR_DELETE",
          "TYPED",
          { name: "LINUX_RUNNER", before: "self-hosted", after: null },
        ],
      ]);
    });

    it("refuses invalid names and secrets-like GITHUB_ names", async () => {
      for (const name of ["GITHUB_TOKEN", "1BAD", "with-dash"]) {
        const res = await variables.setRepoVariable(
          actor("ADMIN"),
          {
            installationId: A,
            repositoryId: 11n,
            name,
            value: "x",
            confirmed: true,
            idempotencyKey: key(),
          },
          deps(),
        );
        expect(res).toMatchObject({
          status: "refused",
          reason: "invalid_name",
        });
      }
      expect(gh.requests).toHaveLength(0);
    });

    it("bulk-sets LINUX_RUNNER on 10 repos via the preset with preview, typed name, audit rows and revert", async () => {
      const ids = BULK_REPOS.map((r) => BigInt(r.id));
      // Some repos already have values, one already has the target value.
      gh.setVariable(101, "LINUX_RUNNER", "ubuntu-latest");
      gh.setVariable(102, "LINUX_RUNNER", "ubuntu-latest");
      gh.setVariable(110, "LINUX_RUNNER", "self-hosted");
      const presets = managementData.variablePresets();
      expect(presets.map((p) => p.name)).toEqual([
        "LINUX_RUNNER",
        "MACOS_RUNNER",
      ]);
      const value = presets[0]!.values[0]!; // "self-hosted"

      const preview = await variables.previewBulkSet(
        actor("ADMIN"),
        { installationId: A, name: "LINUX_RUNNER", value, repositoryIds: ids },
        deps(),
      );
      if (preview.status !== "ok") throw new Error(preview.status);
      expect(
        preview.rows.map((r) => [r.fullName, r.current, r.change]),
      ).toEqual([
        ["example-user/repo-1", "ubuntu-latest", "update"],
        ["example-user/repo-10", "self-hosted", "unchanged"],
        ["example-user/repo-2", "ubuntu-latest", "update"],
        ...BULK_REPOS.slice(2, 9).map((r) => [
          `example-user/${r.name}`,
          null,
          "create",
        ]),
      ]);
      expect(gh.writes()).toHaveLength(0);
      expect(gh.tokens.map((t) => t.purpose)).toEqual(["read.variables"]);

      const bulk = (typed: string, idempotencyKey = key()) =>
        variables.bulkSetVariable(
          actor("ADMIN"),
          {
            installationId: A,
            name: "LINUX_RUNNER",
            value,
            repositoryIds: ids,
            typed,
            idempotencyKey,
          },
          deps(),
        );
      expect(await bulk("LINUX_RUNNE")).toEqual({
        status: "confirmation_mismatch",
      });
      expect(gh.writes()).toHaveLength(0);

      const k = key();
      const done = await bulk("LINUX_RUNNER", k);
      if (done.status !== "succeeded") throw new Error(done.status);
      expect(done.data).toMatchObject({ succeeded: 9, failed: 0 });
      for (const r of BULK_REPOS)
        expect(gh.variable(r.id, "LINUX_RUNNER")).toBe(value);

      const actToken = gh.tokens.find((t) => t.purpose === "act.variables")!;
      expect(actToken.permissions).toEqual({ actions_variables: "write" });
      expect([...actToken.repoIds!].sort((a, b) => a - b)).toEqual(
        BULK_REPOS.map((r) => r.id),
      );

      const rows = await db.auditLog.findMany({
        where: { batchId: done.data!.batchId },
        orderBy: { seq: "asc" },
      });
      // One parent plus one child per changed repo (repo-10 was unchanged).
      expect(rows.filter((r) => r.targetType === "batch")).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "VAR_BULK",
        status: "SUCCEEDED",
        confirmation: "TYPED",
      });
      const children = rows.filter((r) => r.targetType === "variable");
      expect(children).toHaveLength(9);
      expect(children.filter((c) => c.action === "VAR_CREATE")).toHaveLength(7);
      expect(children.filter((c) => c.action === "VAR_UPDATE")).toHaveLength(2);

      // A replay of the same key does not write again and returns the rows.
      const writesBefore = gh.writes().length;
      const replay = await bulk("LINUX_RUNNER", k);
      expect(replay).toMatchObject({ status: "succeeded", replayed: true });
      expect((replay as { data: Variables.BulkResult }).data.succeeded).toBe(9);
      expect(gh.writes()).toHaveLength(writesBefore);

      // Someone changes repo-3 after the batch: revert leaves it alone.
      gh.setVariable(103, "LINUX_RUNNER", "macos-latest");
      const revertPreview = await variables.previewRevert(
        actor("ADMIN"),
        { installationId: A, batchId: done.data!.batchId },
        deps(),
      );
      if (revertPreview.status !== "ok") throw new Error(revertPreview.status);
      const byRepo = new Map(revertPreview.rows.map((r) => [r.fullName, r]));
      expect(byRepo.get("example-user/repo-1")).toMatchObject({
        change: "restore",
        target: "ubuntu-latest",
      });
      expect(byRepo.get("example-user/repo-4")).toMatchObject({
        change: "delete",
      });
      expect(byRepo.get("example-user/repo-3")).toMatchObject({
        change: "skipped",
        reason: "drifted",
      });

      const revert = await variables.revertBatch(
        actor("ADMIN"),
        {
          installationId: A,
          batchId: done.data!.batchId,
          typed: "LINUX_RUNNER",
          idempotencyKey: key(),
        },
        deps(),
      );
      if (revert.status !== "succeeded") throw new Error(revert.status);
      expect(gh.variable(101, "LINUX_RUNNER")).toBe("ubuntu-latest");
      expect(gh.variable(102, "LINUX_RUNNER")).toBe("ubuntu-latest");
      expect(gh.variable(103, "LINUX_RUNNER")).toBe("macos-latest");
      for (const id of [104, 105, 106, 107, 108, 109])
        expect(gh.variable(id, "LINUX_RUNNER")).toBeNull();
      expect(gh.variable(110, "LINUX_RUNNER")).toBe("self-hosted");
      expect(revert.data).toMatchObject({ succeeded: 8, failed: 0 });

      const revertParent = await db.auditLog.findFirstOrThrow({
        where: { action: "VAR_BULK_REVERT" },
      });
      expect(revertParent).toMatchObject({
        targetType: "batch",
        targetId: done.data!.batchId,
        status: "SUCCEEDED",
      });
      expect(revertParent.params).toEqual({
        name: "LINUX_RUNNER",
        revertOf: done.data!.batchId,
      });

      // A batch is reverted at most once.
      expect(
        await variables.revertBatch(
          actor("ADMIN"),
          {
            installationId: A,
            batchId: done.data!.batchId,
            typed: "LINUX_RUNNER",
            idempotencyKey: key(),
          },
          deps(),
        ),
      ).toMatchObject({ status: "refused", reason: "already_reverted" });

      const history = await variablesHistory();
      expect(
        history.map((h) => [h.action, h.succeeded, h.revertedBy !== null]),
      ).toEqual([
        ["VAR_BULK_REVERT", 8, false],
        ["VAR_BULK", 9, true],
      ]);
    });

    it("reports per-repo failures of a bulk set and marks the parent FAILED", async () => {
      gh.failWrites.set(102, 502);
      const res = await variables.bulkSetVariable(
        actor("ADMIN"),
        {
          installationId: A,
          name: "MACOS_RUNNER",
          value: "macos-latest",
          repositoryIds: [101n, 102n, 103n],
          typed: "MACOS_RUNNER",
          idempotencyKey: key(),
        },
        deps(),
      );
      expect(res).toMatchObject({
        status: "failed",
        message: "1 of 3 repositories failed",
        data: { succeeded: 2, failed: 1 },
      });
      const failed = await db.auditLog.findFirstOrThrow({
        where: { status: "FAILED", targetType: "variable" },
      });
      expect(failed).toMatchObject({
        repositoryId: 102n,
        httpStatus: 502,
        error: "Server Error",
      });
    });

    it("skips archived repos and repos that left the selection", async () => {
      await db.repository.update({
        where: { id: 101n },
        data: { archived: true },
      });
      await db.repository.update({
        where: { id: 102n },
        data: { removedAt: new Date() },
      });
      const preview = await variables.previewBulkSet(
        actor("ADMIN"),
        {
          installationId: A,
          name: "LINUX_RUNNER",
          value: "self-hosted",
          repositoryIds: [101n, 102n, 103n],
        },
        deps(),
      );
      if (preview.status !== "ok") throw new Error(preview.status);
      expect(
        preview.rows.map((r) => [r.repositoryId, r.change, r.reason]),
      ).toEqual([
        ["101", "skipped", "archived"],
        ["102", "skipped", "not_selected"],
        ["103", "create", undefined],
      ]);
      const res = await variables.bulkSetVariable(
        actor("ADMIN"),
        {
          installationId: A,
          name: "LINUX_RUNNER",
          value: "self-hosted",
          repositoryIds: [101n, 102n, 103n],
          typed: "LINUX_RUNNER",
          idempotencyKey: key(),
        },
        deps(),
      );
      expect(res.status).toBe("succeeded");
      expect(
        gh.tokens.find((t) => t.purpose === "act.variables")!.repoIds,
      ).toEqual([103]);
      expect(gh.variable(101, "LINUX_RUNNER")).toBeNull();
    });

    it("with redaction on, audits only sha256 and length but can still revert", async () => {
      const toggle = await settings.setVariableRedaction(
        actor("ADMIN"),
        {
          installationId: A,
          enabled: true,
          confirmed: true,
          idempotencyKey: key(),
        },
        deps(),
      );
      expect(toggle.status).toBe("succeeded");
      gh.setVariable(101, "LINUX_RUNNER", "ubuntu-latest");
      const res = await variables.bulkSetVariable(
        actor("ADMIN"),
        {
          installationId: A,
          name: "LINUX_RUNNER",
          value: "runner-1",
          repositoryIds: [101n],
          typed: "LINUX_RUNNER",
          idempotencyKey: key(),
        },
        deps(),
      );
      if (res.status !== "succeeded") throw new Error(res.status);
      const child = await db.auditLog.findFirstOrThrow({
        where: { action: "VAR_UPDATE" },
      });
      const raw = JSON.stringify(child.params);
      expect(raw).not.toContain("ubuntu-latest");
      expect(raw).not.toContain("runner-1");
      const listed = await auditData.listAuditEntries(
        actor("VIEWER").scope,
        A,
        {
          action: "VAR_UPDATE",
        },
      );
      expect(listed.entries[0]!.params).toEqual({
        name: "LINUX_RUNNER",
        before: { redacted: true, sha256: expect.any(String), length: 13 },
        after: { redacted: true, sha256: expect.any(String), length: 8 },
      });
      // Viewers see masked values; admins see them.
      const viewerMatrix = await variablesData.listVariableMatrix(
        actor("VIEWER").scope,
        A,
        gh.clients(),
      );
      if (viewerMatrix.status !== "ok") throw new Error(viewerMatrix.status);
      const cell = viewerMatrix.repos.find((r) => r.repositoryId === "101")!
        .variables.LINUX_RUNNER!;
      expect(cell).toMatchObject({ value: null, masked: true });
      const adminMatrix = await variablesData.listVariableMatrix(
        actor("ADMIN").scope,
        A,
        gh.clients(),
      );
      if (adminMatrix.status !== "ok") throw new Error(adminMatrix.status);
      expect(
        adminMatrix.repos.find((r) => r.repositoryId === "101")!.variables
          .LINUX_RUNNER!.value,
      ).toBe("runner-1");

      const revert = await variables.revertBatch(
        actor("ADMIN"),
        {
          installationId: A,
          batchId: res.data!.batchId,
          typed: "LINUX_RUNNER",
          idempotencyKey: key(),
        },
        deps(),
      );
      expect(revert.status).toBe("succeeded");
      expect(gh.variable(101, "LINUX_RUNNER")).toBe("ubuntu-latest");
    });

    it("keeps an org variable's selection outside the installation and beyond one page", async () => {
      // 150 repos outside this installation plus its own repo-b (22).
      const outside = Array.from({ length: 150 }, (_, i) => 9000 + i);
      gh.orgVariables.set(
        "example-org",
        new Map([
          [
            "LINUX_RUNNER",
            {
              value: "ubuntu-latest",
              visibility: "selected",
              selected: [...outside, 22],
            },
          ],
        ]),
      );
      const matrix = await variablesData.listVariableMatrix(
        actor("VIEWER").scope,
        B,
        gh.clients(),
      );
      if (matrix.status !== "ok" || matrix.org?.status !== "ok")
        throw new Error("matrix");
      // The editor shows this installation's part of the selection.
      expect(matrix.org.variables[0]!.selectedRepositoryIds).toEqual(["22"]);

      const change = (selectedRepositoryIds: bigint[], value: string) =>
        variables.setOrgVariable(
          actor("ADMIN"),
          {
            installationId: B,
            name: "LINUX_RUNNER",
            value,
            visibility: "selected",
            selectedRepositoryIds,
            typed: "LINUX_RUNNER",
            idempotencyKey: key(),
          },
          deps(),
        );
      // Only the value changes: the selection is not sent at all.
      const res = await change([22n], "self-hosted");
      expect(res.status).toBe("succeeded");
      const stored = () =>
        gh.orgVariables.get("example-org")!.get("LINUX_RUNNER")!;
      expect(stored()).toMatchObject({ value: "self-hosted" });
      expect(stored().selected).toHaveLength(151);
      const patch = gh.requests.find((r) =>
        r.route.startsWith("PATCH /orgs/"),
      )!;
      expect(patch.params).not.toHaveProperty("selected_repository_ids");
      const [row] = await auditRows();
      const params = row!.params as {
        before: { selectedRepositoryIds: string[] };
        after: { selectedRepositoryIds: string[] };
      };
      expect(params.before.selectedRepositoryIds).toHaveLength(151);
      expect(params.after.selectedRepositoryIds).toHaveLength(151);

      // Deselecting repo-b removes only repo-b.
      expect((await change([], "self-hosted")).status).toBe("succeeded");
      expect(stored().selected).toEqual(outside);
      // Selecting it again adds only repo-b.
      expect((await change([22n], "self-hosted")).status).toBe("succeeded");
      expect(stored().selected).toEqual([...outside, 22]);
    });

    it("manages organisation variables on org installations only", async () => {
      const set = await variables.setOrgVariable(
        actor("ADMIN"),
        {
          installationId: B,
          name: "LINUX_RUNNER",
          value: "self-hosted",
          visibility: "selected",
          selectedRepositoryIds: [22n],
          typed: "LINUX_RUNNER",
          idempotencyKey: key(),
        },
        deps(),
      );
      expect(set).toMatchObject({
        status: "succeeded",
        data: {
          before: null,
          after: {
            value: "self-hosted",
            visibility: "selected",
            selectedRepositoryIds: ["22"],
          },
        },
      });
      expect(gh.orgVariables.get("example-org")!.get("LINUX_RUNNER")).toEqual({
        value: "self-hosted",
        visibility: "selected",
        selected: [22],
      });
      const orgToken = gh.tokens.find(
        (t) => t.purpose === "act.org_variables",
      )!;
      expect(orgToken).toMatchObject({
        installationId: B,
        permissions: { organization_actions_variables: "write" },
        repoIds: null,
      });
      const matrix = await variablesData.listVariableMatrix(
        actor("VIEWER").scope,
        B,
        gh.clients(),
      );
      if (matrix.status !== "ok") throw new Error(matrix.status);
      expect(matrix.org).toMatchObject({
        status: "ok",
        variables: [
          {
            name: "LINUX_RUNNER",
            value: "self-hosted",
            visibility: "selected",
            selectedRepositoryIds: ["22"],
          },
        ],
      });
      const del = await variables.deleteOrgVariable(
        actor("ADMIN"),
        {
          installationId: B,
          name: "LINUX_RUNNER",
          typed: "LINUX_RUNNER",
          idempotencyKey: key(),
        },
        deps(),
      );
      expect(del.status).toBe("succeeded");
      expect(
        (await auditRows()).map((r) => [r.action, String(r.installationId)]),
      ).toEqual([
        ["ORG_VAR_CREATE", String(B)],
        ["ORG_VAR_DELETE", String(B)],
      ]);
      // A personal account has no organisation variables.
      expect(
        await variables.setOrgVariable(
          actor("ADMIN"),
          {
            installationId: A,
            name: "LINUX_RUNNER",
            value: "x",
            visibility: "all",
            typed: "LINUX_RUNNER",
            idempotencyKey: key(),
          },
          deps(),
        ),
      ).toMatchObject({ status: "refused", reason: "not_organization" });
    });
  });

  describe("dependabot bulk merge", () => {
    const patch = (n: number) => `Bump example-lib from 1.0.0 to 1.0.${n}`;
    const bulk = (
      role: Role,
      items: Array<{ repositoryId: bigint; number: number; sha?: string }>,
      over: Partial<Pulls.BulkMergeInput> = {},
      d: ActionModule.ActionDeps = deps(),
    ) =>
      pulls.bulkMergeDependabot(
        actor(role),
        {
          installationId: A,
          items: items.map((i) => ({ sha: "b".repeat(40), ...i })),
          typed: String(items.length),
          idempotencyKey: key(),
          ...over,
        },
        d,
      );

    it("merges eligible PRs one by one, skips the rest and stops on an unexpected error", async () => {
      gh.addPull({ repoId: 11, number: 21, title: patch(1) });
      gh.addPull({
        repoId: 11,
        number: 22,
        title: "Bump example-lib from 1.0.0 to 2.0.0",
      });
      gh.addPull({
        repoId: 11,
        number: 23,
        title: patch(3),
        checks: "FAILURE",
      });
      gh.addPull({
        repoId: 11,
        number: 24,
        title: patch(4),
        author: "example-user",
      });
      gh.addPull({
        repoId: 11,
        number: 25,
        title: patch(5),
        mergeableState: "blocked",
      });
      gh.addPull({ repoId: 101, number: 1, title: patch(6) });
      gh.addPull({ repoId: 11, number: 26, title: patch(7) });

      const res = await bulk("ADMIN", [
        { repositoryId: 11n, number: 21 },
        { repositoryId: 11n, number: 22 },
        { repositoryId: 11n, number: 23 },
        { repositoryId: 11n, number: 24 },
        { repositoryId: 11n, number: 25 },
        { repositoryId: 11n, number: 99 },
        { repositoryId: 101n, number: 1 },
        { repositoryId: 11n, number: 26 },
      ]);
      // A PR that does not exist is an unexpected error and stops the batch.
      if (res.status !== "failed") throw new Error(res.status);
      expect(
        res.data!.rows.map((r) => [r.number, r.status, r.reason ?? null]),
      ).toEqual([
        [21, "merged", null],
        [22, "skipped", "not_patch_or_minor"],
        [23, "skipped", "checks_not_green"],
        [24, "skipped", "not_dependabot"],
        [25, "skipped", "branch_protection"],
        [99, "failed", "pr_not_found"],
        [1, "not_attempted", null],
        [26, "not_attempted", null],
      ]);
      expect(gh.pulls.get("11#21")!.merged).toBe(true);
      expect(gh.pulls.get("11#26")!.merged).toBe(false);
      expect(gh.writes()).toHaveLength(1);

      const rows = await auditRows();
      expect(rows.map((r) => [r.action, r.status])).toEqual([
        ["PR_BULK_MERGE", "FAILED"],
        ["PR_MERGE", "SUCCEEDED"],
      ]);
      expect(new Set(rows.map((r) => r.batchId)).size).toBe(1);
      expect(rows[1]!.params).toMatchObject({
        number: 21,
        method: "squash",
        updateType: "patch",
      });
      expect(
        gh.tokens
          .filter((t) => t.purpose.startsWith("act."))
          .map((t) => [t.purpose, t.repoIds]),
      ).toEqual([["act.merge", [11]]]);
      expect(
        (await auditData.verifyAuditLog(actor("VIEWER").scope, A)).ok,
      ).toBe(true);
    });

    it("stops after a failed merge and records it", async () => {
      gh.addPull({ repoId: 101, number: 1, title: patch(1) });
      gh.addPull({ repoId: 11, number: 2, title: patch(2) });
      gh.failWrites.set(101, 502);
      const res = await bulk("ADMIN", [
        { repositoryId: 101n, number: 1 },
        { repositoryId: 11n, number: 2 },
      ]);
      if (res.status !== "failed") throw new Error(res.status);
      expect(res.data!.rows.map((r) => [r.number, r.status])).toEqual([
        [1, "failed"],
        [2, "not_attempted"],
      ]);
      expect(res.data!.rows[0]!.message).toBe("Server Error");
      expect((await auditRows()).map((r) => [r.action, r.status])).toEqual([
        ["PR_BULK_MERGE", "FAILED"],
        ["PR_MERGE", "FAILED"],
      ]);
      expect(gh.pulls.get("11#2")!.merged).toBe(false);
    });

    it("skips a PR whose head moved since the dialog", async () => {
      gh.addPull({
        repoId: 11,
        number: 3,
        title: patch(1),
        headSha: "e".repeat(40),
      });
      const res = await bulk("ADMIN", [{ repositoryId: 11n, number: 3 }]);
      if (res.status !== "succeeded") throw new Error(res.status);
      expect(res.data!.rows[0]).toMatchObject({
        status: "skipped",
        reason: "head_moved",
      });
      expect(gh.writes()).toHaveLength(0);
    });

    it("needs an admin, the typed count and the installation's repos", async () => {
      gh.addPull({ repoId: 11, number: 4, title: patch(1) });
      const items = [{ repositoryId: 11n, number: 4 }];
      expect(await bulk("OPERATOR", items)).toEqual({ status: "forbidden" });
      expect(await bulk("ADMIN", items, { typed: "2" })).toEqual({
        status: "confirmation_mismatch",
      });
      await expect(
        bulk("ADMIN", [{ repositoryId: 22n, number: 1 }]),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      expect(gh.writes()).toHaveLength(0);
      expect((await auditRows()).map((r) => [r.action, r.status])).toEqual([
        ["PR_BULK_MERGE", "DENIED"],
      ]);
    });
  });

  describe("pull requests", () => {
    it("merges a PR without workflow changes with a token without workflows", async () => {
      gh.addPull({ repoId: 11, number: 1, files: ["package.json"] });
      expect((await merge("ADMIN")).status).toBe("succeeded");
      const mergeToken = gh.tokens.find((t) => t.purpose.startsWith("act."))!;
      expect(mergeToken).toEqual({
        installationId: A,
        purpose: "act.merge",
        permissions: { contents: "write", pull_requests: "write" },
        repoIds: [11],
      });
      const put = gh.writes()[0]!;
      expect(put.params).toMatchObject({
        sha: "b".repeat(40),
        merge_method: "squash",
      });
      expect(put.params.commit_message).toBeUndefined();
    });

    it("merges a Dependabot PR that updates an Action with an act.merge.workflows token", async () => {
      gh.addPull({
        repoId: 11,
        number: 2,
        files: [".github/workflows/ci.yml"],
        title: "Bump actions/checkout",
      });
      const res = await merge("ADMIN", { number: 2 });
      expect(res).toMatchObject({
        status: "succeeded",
        data: {
          merged: true,
          workflowsTouched: true,
          mergeCommitSha: "c".repeat(40),
        },
      });
      const mergeToken = gh.tokens.find((t) => t.purpose.startsWith("act."))!;
      expect(mergeToken).toMatchObject({
        purpose: "act.merge.workflows",
        permissions: {
          contents: "write",
          pull_requests: "write",
          workflows: "write",
        },
        repoIds: [11],
      });
      const row = await db.auditLog.findFirstOrThrow({
        where: { action: "PR_MERGE" },
      });
      expect(row.params).toMatchObject({
        method: "squash",
        sha: "b".repeat(40),
        workflowsTouched: true,
      });
    });

    it("explains a workflow-changing PR when Workflows: write is not granted", async () => {
      await db.installation.update({
        where: { id: A },
        data: { permissions: { ...FULL, workflows: undefined } },
      });
      gh.addPull({
        repoId: 11,
        number: 2,
        files: [".github/workflows/ci.yml"],
      });
      expect(await merge("ADMIN", { number: 2 })).toEqual({
        status: "permission_not_granted",
        missing: ["workflows:write"],
      });
      expect(gh.writes()).toHaveLength(0);
    });

    it("refuses a PR that is not mergeable or blocked without a merge call", async () => {
      gh.addPull({
        repoId: 11,
        number: 3,
        mergeable: false,
        mergeableState: "dirty",
      });
      expect(await merge("ADMIN", { number: 3 })).toMatchObject({
        status: "refused",
        reason: "not_mergeable",
      });
      gh.addPull({ repoId: 11, number: 4, draft: true });
      expect(await merge("ADMIN", { number: 4 })).toMatchObject({
        status: "refused",
        reason: "draft",
      });
      gh.addPull({ repoId: 11, number: 5, mergeableState: "unstable" });
      expect(await merge("ADMIN", { number: 5 })).toMatchObject({
        status: "refused",
        reason: "needs_acknowledgement",
        detail: { mergeableState: "unstable" },
      });
      // Branch protection is never overridden, not even with the warning
      // acknowledged (the App may be a bypass actor).
      gh.addPull({ repoId: 11, number: 7, mergeableState: "blocked" });
      expect(
        await merge("ADMIN", { number: 7, acknowledgeNotClean: true }),
      ).toEqual({ status: "refused", reason: "branch_protection" });
      gh.addPull({ repoId: 11, number: 8, mergeableState: "dirty" });
      expect(
        await merge("ADMIN", { number: 8, acknowledgeNotClean: true }),
      ).toMatchObject({ status: "refused", reason: "not_mergeable" });
      gh.addPull({ repoId: 11, number: 9, mergeableState: "unknown" });
      expect(
        await merge("ADMIN", { number: 9, acknowledgeNotClean: true }),
      ).toMatchObject({ status: "refused", reason: "mergeability_unknown" });
      expect(gh.writes()).toHaveLength(0);
      expect(await db.auditLog.count()).toBe(0);
      expect(
        (await merge("ADMIN", { number: 5, acknowledgeNotClean: true })).status,
      ).toBe("succeeded");
    });

    it("fails a merge with a stale SHA with GitHub's 409 verbatim", async () => {
      gh.addPull({ repoId: 11, number: 6, headSha: "d".repeat(40) });
      const res = await merge("ADMIN", { number: 6, sha: "b".repeat(40) });
      expect(res).toMatchObject({
        status: "failed",
        httpStatus: 409,
        message: "Head branch was modified. Review and try the merge again.",
      });
      const row = await db.auditLog.findFirstOrThrow({
        where: { action: "PR_MERGE" },
      });
      expect(row).toMatchObject({
        status: "FAILED",
        httpStatus: 409,
        error: "Head branch was modified. Review and try the merge again.",
      });
      expect(row.githubRequestId).toMatch(/^REQ-/);
    });

    it("adds the audit trailer to the merge commit when MERGE_AUDIT_TRAILER is on", async () => {
      gh.addPull({ repoId: 11, number: 7 });
      const res = await merge(
        "ADMIN",
        { number: 7 },
        deps({ mergeAuditTrailer: true }),
      );
      if (res.status !== "succeeded") throw new Error(res.status);
      // A single-commit squash keeps the commit's body.
      expect(gh.writes()[0]!.params.commit_message).toBe(
        `Bumps example-lib to 7.0.0.\n\nDevOps-Manager-Audit: ${res.auditId}`,
      );

      // A multi-commit squash keeps the commit list and the co-authors.
      gh.addPull({
        repoId: 11,
        number: 8,
        author: "example-user",
        commits: [
          {
            message: "Add feature\n\nCo-authored-by: Pair <pair@example.com>",
            login: "example-user",
            name: "Example User",
            email: "user@example.com",
          },
          {
            message: "Fix tests",
            login: "example-helper",
            name: "Example Helper",
            email: "helper@example.com",
          },
        ],
      });
      const squash = await merge(
        "ADMIN",
        { number: 8 },
        deps({ mergeAuditTrailer: true }),
      );
      if (squash.status !== "succeeded") throw new Error(squash.status);
      expect(gh.writes()[1]!.params.commit_message).toBe(
        [
          "* Add feature",
          "",
          "* Fix tests",
          "",
          "Co-authored-by: Pair <pair@example.com>",
          "Co-authored-by: Example Helper <helper@example.com>",
          `DevOps-Manager-Audit: ${squash.auditId}`,
        ].join("\n"),
      );

      // A merge commit keeps the PR title as its body.
      gh.addPull({ repoId: 11, number: 9 });
      const mergeCommit = await merge(
        "ADMIN",
        { number: 9, method: "merge" },
        deps({ mergeAuditTrailer: true }),
      );
      if (mergeCommit.status !== "succeeded")
        throw new Error(mergeCommit.status);
      expect(gh.writes()[2]!.params.commit_message).toBe(
        `Update dependency 9\n\nDevOps-Manager-Audit: ${mergeCommit.auditId}`,
      );

      // A rebase has no merge commit: no message, recorded in the audit row.
      gh.addPull({ repoId: 11, number: 10 });
      const rebase = await merge(
        "ADMIN",
        { number: 10, method: "rebase" },
        deps({ mergeAuditTrailer: true }),
      );
      if (rebase.status !== "succeeded") throw new Error(rebase.status);
      expect(gh.writes()[3]!.params.commit_message).toBeUndefined();
      const rows = await auditRows();
      expect(
        rows.map((r) => (r.params as { auditTrailer: boolean }).auditTrailer),
      ).toEqual([true, true, true, false]);
    });

    it("lists open PRs with checks, mergeability and chips", async () => {
      gh.addPull({
        repoId: 11,
        number: 1,
        files: [".github/workflows/ci.yml"],
      });
      gh.addPull({
        repoId: 11,
        number: 2,
        author: "example-user",
        mergeable: false,
        mergeableState: "dirty",
        checks: "FAILURE",
      });
      gh.addPull({ repoId: 22, number: 9 });
      const overview = await pullsData.listOpenPulls(
        actor("VIEWER").scope,
        A,
        gh.clients(),
      );
      if (overview.status !== "ok") throw new Error(overview.status);
      expect(overview.workflowsGranted).toBe(true);
      expect(
        overview.pulls.map((p) => [
          p.repoFullName,
          p.number,
          p.isDependabot,
          p.changesWorkflows,
          p.mergeable,
          p.checks,
        ]),
      ).toEqual([
        ["example-user/repo-a", 2, false, false, "CONFLICTING", "FAILURE"],
        ["example-user/repo-a", 1, true, true, "MERGEABLE", "SUCCESS"],
      ]);
      expect(
        overview.repos.find((r) => r.fullName === "example-user/repo-a"),
      ).toMatchObject({ status: "ok", mergeMethods: ["merge", "squash"] });
      const token = gh.tokens[0]!;
      expect(token.purpose).toBe("read.pulls");
      expect(token.installationId).toBe(A);
      expect(token.repoIds).not.toContain(22);
    });
  });

  describe("dependabot", () => {
    it("follows the cursor of the Link header and counts each alert once", async () => {
      gh.alerts.set(
        11,
        Array.from({ length: 150 }, (_, i) => ({
          number: i + 1,
          html_url: `https://github.com/example-user/repo-a/security/dependabot/${i + 1}`,
          dependency: {
            package: { name: `example-lib-${i}`, ecosystem: "npm" },
            manifest_path: "package.json",
          },
          security_advisory: {
            ghsa_id: "GHSA-xxxx-xxxx-xxxx",
            summary: "Example advisory",
            severity: "low",
          },
          security_vulnerability: { severity: "low" },
          created_at: "2026-11-01T00:00:00Z",
        })),
      );
      const res = await dependabot.listDependabotAlerts(
        actor("VIEWER").scope,
        A,
        gh.clients(),
      );
      if (res.status !== "ok") throw new Error(res.status);
      expect(res.totals.low).toBe(150);
      expect(new Set(res.alerts.map((a) => a.number)).size).toBe(150);
      const calls = gh.requests.filter((r) =>
        r.route.endsWith("/dependabot/alerts"),
      );
      expect(calls.filter((c) => c.params.after)).toHaveLength(1);
      expect(calls.every((c) => c.params.page === undefined)).toBe(true);
    });

    it("lists open alerts by severity, read-only", async () => {
      gh.alerts.set(11, [
        {
          number: 1,
          html_url:
            "https://github.com/example-user/repo-a/security/dependabot/1",
          dependency: {
            package: { name: "example-lib", ecosystem: "npm" },
            manifest_path: "package.json",
          },
          security_advisory: {
            ghsa_id: "GHSA-xxxx-xxxx-xxxx",
            summary: "Example advisory",
            severity: "high",
          },
          security_vulnerability: {
            severity: "high",
            first_patched_version: { identifier: "1.2.3" },
          },
        },
      ]);
      const res = await dependabot.listDependabotAlerts(
        actor("VIEWER").scope,
        A,
        gh.clients(),
      );
      if (res.status !== "ok") throw new Error(res.status);
      expect(res.totals).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
      expect(res.alerts[0]).toMatchObject({
        repoFullName: "example-user/repo-a",
        packageName: "example-lib",
        fixedIn: "1.2.3",
        ghsaId: "GHSA-xxxx-xxxx-xxxx",
      });
      // Repos without alerts enabled answer 403 and are marked, not failed.
      expect(res.repos.find((r) => r.repositoryId === "101")!.status).toBe(
        "disabled",
      );
      expect(gh.writes()).toHaveLength(0);
      expect(gh.tokens.map((t) => [t.purpose, t.permissions])).toEqual([
        ["read.dependabot", { vulnerability_alerts: "read" }],
      ]);
    });
  });

  describe("audit log", () => {
    it("verifies the chain and detects a manually modified, removed or re-sealed row", async () => {
      await rerun("OPERATOR");
      await setVar("ADMIN", "self-hosted");
      await setVar("ADMIN", "ubuntu-latest");
      await rerun("VIEWER");
      const viewer = actor("VIEWER").scope;
      expect(await auditData.verifyAuditLog(viewer, A)).toEqual({
        ok: true,
        checked: 4,
        unsealed: 0,
        firstBreak: null,
      });

      const [, second, third] = await auditRows();
      // A changed parameter (immutable field).
      await db.$executeRawUnsafe(
        `UPDATE "AuditLog" SET "params" = '{"name":"LINUX_RUNNER","before":null,"after":"evil"}' WHERE "id" = $1`,
        second!.id,
      );
      expect((await auditData.verifyAuditLog(viewer, A)).firstBreak).toEqual({
        seq: second!.seq.toString(),
        id: second!.id,
        reason: "hash",
      });
      await db.$executeRawUnsafe(
        `UPDATE "AuditLog" SET "params" = $2::jsonb WHERE "id" = $1`,
        second!.id,
        JSON.stringify(second!.params),
      );
      expect((await auditData.verifyAuditLog(viewer, A)).ok).toBe(true);

      // A changed outcome.
      await db.$executeRawUnsafe(
        `UPDATE "AuditLog" SET "status" = 'FAILED' WHERE "id" = $1`,
        third!.id,
      );
      expect(
        (await auditData.verifyAuditLog(viewer, A)).firstBreak,
      ).toMatchObject({
        id: third!.id,
        reason: "result_hash",
      });
      await db.$executeRawUnsafe(
        `UPDATE "AuditLog" SET "status" = 'SUCCEEDED' WHERE "id" = $1`,
        third!.id,
      );

      // A removed row breaks the link of its successor.
      await db.$executeRawUnsafe(
        `DELETE FROM "AuditLog" WHERE "id" = $1`,
        second!.id,
      );
      expect(
        (await auditData.verifyAuditLog(viewer, A)).firstBreak,
      ).toMatchObject({
        id: third!.id,
        reason: "prev_hash",
      });
    });

    it("detects removed newest rows and outcomes hidden as PENDING or unsealed", async () => {
      await rerun("OPERATOR");
      await setVar("ADMIN", "self-hosted");
      await setVar("ADMIN", "ubuntu-latest");
      const viewer = actor("VIEWER").scope;
      const [first, second, third] = await auditRows();
      expect(await auditData.verifyAuditLog(viewer, A)).toMatchObject({
        ok: true,
      });

      // An outcome edited back to PENDING.
      await db.$executeRawUnsafe(
        `UPDATE "AuditLog" SET "status" = 'PENDING', "resultHash" = NULL WHERE "id" = $1`,
        second!.id,
      );
      expect(
        (await auditData.verifyAuditLog(viewer, A)).firstBreak,
      ).toMatchObject({ id: second!.id, reason: "result_hash" });
      // Every result hash removed: still sealed rows, not legacy ones.
      await db.$executeRawUnsafe(
        `UPDATE "AuditLog" SET "status" = 'SUCCEEDED', "resultHash" = NULL`,
      );
      expect(
        (await auditData.verifyAuditLog(viewer, A)).firstBreak,
      ).toMatchObject({ id: first!.id, reason: "result_hash" });
      await db.$executeRawUnsafe(
        `UPDATE "AuditLog" SET "resultHash" = $2 WHERE "id" = $1`,
        first!.id,
        first!.resultHash,
      );
      for (const row of [second!, third!])
        await db.$executeRawUnsafe(
          `UPDATE "AuditLog" SET "resultHash" = $2 WHERE "id" = $1`,
          row.id,
          row.resultHash,
        );
      expect((await auditData.verifyAuditLog(viewer, A)).ok).toBe(true);

      // The newest row removed: the chain no longer reaches its head ...
      await db.$executeRawUnsafe(
        `DELETE FROM "AuditLog" WHERE "id" = $1`,
        third!.id,
      );
      expect(
        (await auditData.verifyAuditLog(viewer, A)).firstBreak,
      ).toMatchObject({ seq: third!.seq.toString(), reason: "truncated" });
      // ... and the next row still links to the removed one.
      await rerun("OPERATOR");
      const next = (await auditRows()).at(-1)!;
      expect(next.prevHash).toBe(third!.hash);
      expect(
        (await auditData.verifyAuditLog(viewer, A)).firstBreak,
      ).toMatchObject({ id: next.id, reason: "prev_hash" });

      // The head only moves forward and cannot be removed.
      await expect(
        db.$executeRawUnsafe(
          `DELETE FROM "AuditChainHead" WHERE "installationId" = $1`,
          A,
        ),
      ).rejects.toThrow();
      await expect(
        db.$executeRawUnsafe(
          `UPDATE "AuditChainHead" SET "seq" = "seq" - 1 WHERE "installationId" = $1`,
          A,
        ),
      ).rejects.toThrow();
    });

    it("chains per installation and keeps the instance chain admin-only", async () => {
      await rerun("OPERATOR");
      await runs.performRunAction(
        actor("OPERATOR"),
        {
          installationId: B,
          runId: RUN_B,
          operation: "rerun",
          confirmed: true,
          idempotencyKey: key(),
        },
        deps(),
      );
      const rows = await auditRows();
      expect(rows.every((r) => r.prevHash === "0".repeat(64))).toBe(true);
      expect(
        (await auditData.verifyAuditLog(actor("VIEWER").scope, B)).ok,
      ).toBe(true);
      await expect(
        auditData.listAuditEntries(
          actor("OPERATOR").scope,
          auditData.INSTANCE_CHAIN,
        ),
      ).rejects.toBeInstanceOf(installations.NotFoundError);
      expect(
        (
          await auditData.listAuditEntries(
            actor("ADMIN").scope,
            auditData.INSTANCE_CHAIN,
          )
        ).entries,
      ).toEqual([]);
    });

    it("lists, filters, pages and exports entries for every role", async () => {
      await rerun("OPERATOR");
      await rerun("VIEWER");
      await setVar("ADMIN", "=cmd()");
      const viewer = actor("VIEWER").scope;
      const all = await auditData.listAuditEntries(viewer, A, {}, { limit: 2 });
      expect(all.entries.map((e) => e.action)).toEqual([
        "VAR_CREATE",
        "RUN_RERUN",
      ]);
      expect(all.nextBefore).not.toBeNull();
      const older = await auditData.listAuditEntries(
        viewer,
        A,
        {},
        { limit: 2, before: all.nextBefore! },
      );
      expect(older.entries.map((e) => [e.action, e.status])).toEqual([
        ["RUN_RERUN", "SUCCEEDED"],
      ]);
      const denied = await auditData.listAuditEntries(viewer, A, {
        status: "DENIED",
      });
      expect(denied.entries.map((e) => e.actorDisplay)).toEqual(["viewer"]);
      expect(denied.entries[0]).toMatchObject({
        actorRole: "VIEWER",
        actingAs: null,
      });
      const csv = await auditData.auditCsv(viewer, A);
      const lines = csv.trim().split("\r\n");
      expect(lines).toHaveLength(4);
      expect(lines[0]).toContain("actorDisplay");
      expect(csv).not.toMatch(/,=cmd/);
    });
  });

  describe("management state", () => {
    it("reports the switches and role hints for the UI", async () => {
      expect(
        await managementData.getManagementState(actor("OPERATOR").scope, A),
      ).toMatchObject({
        globalEnabled: true,
        installationEnabled: true,
        enabled: true,
        canOperate: true,
        canAdmin: false,
        accountType: "USER",
      });
      await db.installation.update({
        where: { id: B },
        data: { managementEnabled: false },
      });
      expect(
        await managementData.getManagementState(actor("ADMIN").scope, B),
      ).toMatchObject({ enabled: false, canOperate: false, canAdmin: false });
    });
  });

  async function variablesHistory() {
    return auditData.listVariableBatches(actor("VIEWER").scope, A);
  }
});
