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
import type { TenantScope } from "@/server/authz/scope";
import type * as AzureData from "@/server/data/azure";
import type * as CiRuns from "@/server/data/ci-runs";
import type * as Db from "@/server/db";
import type * as Budget from "@/server/ingest/budget";
import type * as Connect from "@/server/ingest/azure-connect";
import type * as Credential from "@/server/ingest/azure-credential";
import type * as Hints from "@/server/ingest/azure-hints";
import type * as Hook from "@/server/ingest/azure-hook";
import type * as HookStore from "@/server/ingest/azure-hook-store";
import type * as Step from "@/server/ingest/azure-reconcile";
import type * as Rollup from "@/server/ingest/azure-rollup";
import type * as Reconcile from "@/server/ingest/reconcile";
import type * as Provider from "@/server/ingest/provider-step";
import type * as AuditLog from "@/server/audit/log";
import type * as Mgmt from "@/server/management/azure";
import type * as Actions from "@/server/management/azure-actions";
import type * as Entra from "@/server/azure/entra";
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
import {
  FAKE_ORG,
  FAKE_ORG_ID,
  FakeAzureDevOps,
  OTHER_ORG,
  P1,
  P2,
  P3,
  PII_EMAIL,
  PII_NAME,
} from "./support/azure-devops";

/**
 * Azure DevOps (design addendum M7, M7b, M7c) against a real Postgres and
 * FakeAzureDevOps: connect, rotate and disconnect (PAT and service
 * principal), reconcile step z (cursor chains, retries, sweep, backfill,
 * budgets and stop rules), usage and findings, check run hints and the
 * service hook, the union views, and the M7b actions with their gates and
 * audit rows. Every name and id is a placeholder; credentials are
 * deliberately not in a real PAT format.
 */

vi.mock("next/cache", () => ({ revalidateTag: () => undefined }));
vi.mock("next/server", () => ({ after: () => undefined }));

const PAT = "test-pat-not-real-azure-0001"; // gitleaks:allow (test placeholder)
const PAT_EXEC = "test-pat-not-real-azure-exec1"; // gitleaks:allow (test placeholder)
const PAT_OTHER = "test-pat-not-real-azure-other"; // gitleaks:allow (test placeholder)
const PAT_NOPOOLS = "test-pat-not-real-azure-nopool"; // gitleaks:allow (test placeholder)
const SP_SECRET = "test-sp-secret-not-real-0001"; // gitleaks:allow (test placeholder)
const TENANT = "00000000-0000-4000-8000-0000000000aa";
const CLIENT = "00000000-0000-4000-8000-0000000000bb";
const PREVIOUS_KEY = Buffer.alloc(32, 9).toString("base64");
const MIN = 60_000;
const DAY = 86_400_000;
const json = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) =>
    typeof x === "bigint" ? x.toString() : x,
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
let data: typeof AzureData;
let ci: typeof CiRuns;
let budget: typeof Budget;
let connect: typeof Connect;
let credential: typeof Credential;
let hints: typeof Hints;
let hook: typeof Hook;
let hookStore: typeof HookStore;
let step: typeof Step;
let rollup: typeof Rollup;
let reconcile: typeof Reconcile;
let provider: typeof Provider;
let auditLog: typeof AuditLog;
let mgmt: typeof Mgmt;
let actions: typeof Actions;
let entra: typeof Entra;

describe.skipIf(!DATABASE_URL)("azure devops (M7)", () => {
  let az: FakeAzureDevOps;
  let gh: FakeGitHub;
  const deps = (over: Record<string, unknown> = {}) =>
    mgmt.defaultAzureDeps({
      clients: gh.clients(),
      revalidate: () => undefined,
      managementEnabled: true,
      azureManagementEnabled: true,
      mergeAuditTrailer: false,
      fetch: az.fetch(),
      azureFetch: az.fetch(),
      schedule: () => undefined,
      ...over,
    });
  const deadline = (ms = 60_000) => new budget.Deadline(Date.now() + ms);
  const runStep = (opts: Partial<Step.AzureStepOptions> = {}) =>
    step.runAzureStep({
      installationId: B,
      timezone: "UTC",
      retentionDays: 90,
      deadline: deadline(),
      fetch: az.fetch(),
      envCredential: null,
      ...opts,
    });
  const connectB = (pat = PAT, org = FAKE_ORG, role: Role = "ADMIN") =>
    mgmt.connectAzure(
      actor(role),
      {
        installationId: B,
        org,
        authKind: "PAT",
        pat,
        expiresAt: null,
        confirmed: true,
        idempotencyKey: randomUUID(),
      },
      deps(),
    );

  beforeAll(async () => {
    setActionsEnv({
      OPERATOR_EMAILS: USERS.OPERATOR.email,
      VIEWER_EMAILS: USERS.VIEWER.email,
      ADMIN_EMAILS: USERS.ADMIN.email,
      TOKEN_ENCRYPTION_KEY_PREVIOUS: PREVIOUS_KEY,
      NEXT_PUBLIC_APP_URL: "https://devops.example.com",
    });
    ({ db } = await import("@/server/db"));
    data = await import("@/server/data/azure");
    ci = await import("@/server/data/ci-runs");
    budget = await import("@/server/ingest/budget");
    connect = await import("@/server/ingest/azure-connect");
    credential = await import("@/server/ingest/azure-credential");
    hints = await import("@/server/ingest/azure-hints");
    hook = await import("@/server/ingest/azure-hook");
    hookStore = await import("@/server/ingest/azure-hook-store");
    step = await import("@/server/ingest/azure-reconcile");
    rollup = await import("@/server/ingest/azure-rollup");
    reconcile = await import("@/server/ingest/reconcile");
    provider = await import("@/server/ingest/provider-step");
    auditLog = await import("@/server/audit/log");
    mgmt = await import("@/server/management/azure");
    actions = await import("@/server/management/azure-actions");
    entra = await import("@/server/azure/entra");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await db?.$disconnect();
  });

  beforeEach(async () => {
    connect.resetAzureEnvAttempts();
    entra.clearEntraCache();
    await resetTables(db);
    await db.$executeRawUnsafe(
      `TRUNCATE "RateLimitBucket", "Session", "Account", "User" CASCADE`,
    );
    await seedInstallations(db, { permissions: { checks: "read" } });
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
    gh = new FakeGitHub();
    az = new FakeAzureDevOps();
    az.addPat(PAT, FAKE_ORG, ["projects", "pools", "build"]);
    az.addPat(PAT_EXEC, FAKE_ORG, [
      "projects",
      "pools",
      "build",
      "execute",
      "hooks",
    ]);
    az.addPat(PAT_OTHER, OTHER_ORG, ["projects", "pools", "build"]);
    az.addPat(PAT_NOPOOLS, FAKE_ORG, ["projects", "build"]);
    az.addClient({
      tenantId: TENANT,
      clientId: CLIENT,
      secret: SP_SECRET,
      scopes: ["projects", "pools", "build", "execute"],
    });
    az.projects = [
      { id: P1, name: "project-a", visibility: "private", org: FAKE_ORG },
      { id: P2, name: "project-b", visibility: "public", org: FAKE_ORG },
      { id: P3, name: "project-c", visibility: "private", org: FAKE_ORG },
      {
        id: "00000000-0000-4000-8000-000000000021",
        name: "other-project",
        visibility: "private",
        org: OTHER_ORG,
      },
    ];
    az.definitions = [
      { id: 3, projectId: P1, name: "ci", repoFullName: "example-org/repo-b" },
      {
        id: 4,
        projectId: P1,
        name: "legacy",
        repoFullName: "example-other/legacy-app",
      },
      {
        id: 5,
        projectId: P2,
        name: "docs",
        repoFullName: "example-org/repo-b",
      },
      {
        id: 6,
        projectId: P3,
        name: "mobile",
        repoFullName: "example-org/repo-b",
      },
    ];
  });

  // ---------- M7.1 connection ----------

  describe("connection", () => {
    it("connects a read-only PAT, stores it as ciphertext with AAD and suggests the projects", async () => {
      const r = await connectB();
      expect(r).toMatchObject({
        status: "succeeded",
        data: { orgName: FAKE_ORG, suggested: 3 },
      });
      const c = await db.azureDevOpsConnection.findUniqueOrThrow({
        where: { installationId: B },
      });
      expect(c.orgId).toBe(FAKE_ORG_ID);
      expect(c.accessToken).not.toContain(PAT);
      expect(
        credential.decryptAzureSecret(B, "accessToken", c.accessToken!),
      ).toBe(PAT);
      expect(() =>
        createKeyRing(process.env.TOKEN_ENCRYPTION_KEY!).decrypt(
          c.accessToken!,
          `AzureDevOpsConnection:${A}:accessToken`,
        ),
      ).toThrow();
      expect(c.scopes).toMatchObject({
        projects: "ok",
        pools: "ok",
        builds: "ok",
        execute: "unknown",
      });
      const projects = await db.azureDevOpsProject.findMany({
        where: { installationId: B },
        orderBy: { name: "asc" },
      });
      expect(projects.map((p) => [p.name, p.selected])).toEqual([
        ["project-a", true],
        ["project-b", true],
        ["project-c", true],
      ]);
      const audit = await db.auditLog.findFirstOrThrow({
        where: { action: "ADO_CONNECT" },
      });
      const text = json(audit);
      expect(text).not.toContain(PAT);
      expect(text).not.toContain(FAKE_ORG);
      expect(audit.params).toMatchObject({
        orgId: FAKE_ORG_ID,
        authKind: "PAT",
      });
      expect(audit.actingAs).toBe(`azure:pat:${PAT.slice(-4)}`);
    });

    it("gives a specific error for a missing scope and writes nothing for a bad PAT or a sign-in page", async () => {
      expect(await connectB(PAT_NOPOOLS)).toMatchObject({
        status: "failed",
        message: "scope_missing_pools",
      });
      expect(await connectB("test-pat-not-real-unknown-1")).toMatchObject({
        status: "failed",
        message: "invalid_token",
      });
      az.signInPageFor203 = true;
      expect(await connectB("test-pat-not-real-unknown-2")).toMatchObject({
        status: "failed",
        message: "invalid_token",
      });
      expect(await db.azureDevOpsConnection.count()).toBe(0);
      expect(await db.azureDevOpsProject.count()).toBe(0);
      expect(await connectB(PAT, "https://evil.example.com/x")).toMatchObject({
        status: "failed",
        message: "invalid_org",
      });
      expect(az.calls.every((c) => c.host === "dev.azure.com")).toBe(true);
    });

    it("lets one installation only claim an organisation and refuses a rotate to another organisation", async () => {
      await connectB();
      const r = await mgmt.connectAzure(
        actor("ADMIN"),
        {
          installationId: A,
          org: FAKE_ORG,
          authKind: "PAT",
          pat: PAT,
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      expect(r).toMatchObject({
        status: "failed",
        message: "already_connected_elsewhere",
      });
      const rot = await mgmt.rotateAzureCredential(
        actor("ADMIN"),
        {
          installationId: B,
          authKind: "PAT",
          pat: PAT_OTHER,
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      // The rotate keeps the stored organisation; a PAT of another one is rejected by it.
      expect(rot).toMatchObject({ status: "failed" });
      const c = await db.azureDevOpsConnection.findUniqueOrThrow({
        where: { installationId: B },
      });
      expect(
        credential.decryptAzureSecret(B, "accessToken", c.accessToken!),
      ).toBe(PAT);
    });

    it("refuses a viewer and an operator (admin only) with DENIED rows", async () => {
      expect(await connectB(PAT, FAKE_ORG, "VIEWER")).toEqual({
        status: "forbidden",
      });
      expect(await connectB(PAT, FAKE_ORG, "OPERATOR")).toEqual({
        status: "forbidden",
      });
      expect(
        await db.auditLog.count({
          where: { status: "DENIED", action: "ADO_CONNECT" },
        }),
      ).toBe(2);
    });

    it("never persists the env credential", async () => {
      const r = await runStep({
        envCredential: {
          org: FAKE_ORG,
          accountLogin: "example-org",
          kind: "pat",
          pat: PAT,
        },
      });
      expect(r.status).not.toBe("none");
      const c = await db.azureDevOpsConnection.findUniqueOrThrow({
        where: { installationId: B },
      });
      expect(c.authKind).toBe("ENV");
      expect(c.accessToken).toBeNull();
      const all = json(
        await db.$queryRawUnsafe(
          `SELECT row_to_json(c)::text AS t FROM "AzureDevOpsConnection" c`,
        ),
      );
      expect(all).not.toContain(PAT);
    });

    it("re-encrypts the Azure secrets under a rotated key (k2)", async () => {
      const old = createKeyRing(PREVIOUS_KEY);
      await db.azureDevOpsConnection.create({
        data: {
          installationId: B,
          orgId: FAKE_ORG_ID,
          orgName: FAKE_ORG,
          authKind: "PAT",
          accessToken: old.encrypt(PAT, credential.azureAad(B, "accessToken")),
          hookKey: "hookkey0123456789abcd",
          hookSecret: old.encrypt("s1", credential.azureAad(B, "hookSecret")),
          hookSecretPrev: old.encrypt(
            "s0",
            credential.azureAad(B, "hookSecretPrev"),
          ),
          createdByUserId: "test",
        },
      });
      const r = await provider.reencryptColumns(
        [credential.azureEncryptedColumns],
        () => false,
      );
      expect(r).toEqual({ reencrypted: 1, failed: 0 });
      const c = await db.azureDevOpsConnection.findUniqueOrThrow({
        where: { installationId: B },
      });
      const ring = createKeyRing(process.env.TOKEN_ENCRYPTION_KEY!);
      for (const v of [c.accessToken!, c.hookSecret!, c.hookSecretPrev!])
        expect(ring.needsReencrypt(v)).toBe(false);
      expect(
        credential.decryptAzureSecret(B, "hookSecretPrev", c.hookSecretPrev!),
      ).toBe("s0");
    });
  });

  // ---------- M7c service principal ----------

  describe("service principal (M7c)", () => {
    it("connects with client credentials and switches from a PAT keeping the organisation and history", async () => {
      await connectB();
      az.addBuild({ definitionId: 3, queuedAt: Date.now() - 30 * MIN });
      await runStep();
      const before = await db.azureBuild.count({
        where: { installationId: B },
      });
      expect(before).toBe(1);
      const r = await mgmt.rotateAzureCredential(
        actor("ADMIN"),
        {
          installationId: B,
          authKind: "ENTRA_SP",
          tenantId: TENANT,
          clientId: CLIENT,
          clientSecret: SP_SECRET,
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      expect(r).toMatchObject({
        status: "succeeded",
        data: { authKind: "ENTRA_SP" },
      });
      const c = await db.azureDevOpsConnection.findUniqueOrThrow({
        where: { installationId: B },
      });
      expect(c).toMatchObject({
        authKind: "ENTRA_SP",
        orgId: FAKE_ORG_ID,
        tenantId: TENANT,
        clientId: CLIENT,
      });
      expect(await db.azureBuild.count({ where: { installationId: B } })).toBe(
        before,
      );
      az.calls.length = 0;
      entra.clearEntraCache();
      expect((await runStep({ forceDefinitions: true })).status).toBe("ok");
      expect(
        az.calls.some((c2) => c2.host === "login.microsoftonline.com"),
      ).toBe(true);
      const audit = await db.auditLog.findFirstOrThrow({
        where: { action: "ADO_TOKEN_ROTATE", status: "SUCCEEDED" },
      });
      expect(audit.actingAs).toBe(`azure:sp:${SP_SECRET.slice(-4)}`);
      expect(json(audit)).not.toContain(SP_SECRET);
    });

    it("raises credential:azure:revoked when the secret is rejected", async () => {
      await mgmt.connectAzure(
        actor("ADMIN"),
        {
          installationId: B,
          org: FAKE_ORG,
          authKind: "ENTRA_SP",
          tenantId: TENANT,
          clientId: CLIENT,
          clientSecret: SP_SECRET,
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      az.clients.clear();
      entra.clearEntraCache();
      const r = await runStep();
      expect(r.status).toBe("credential_error");
      expect(
        (
          await db.azureDevOpsConnection.findUniqueOrThrow({
            where: { installationId: B },
          })
        ).revokedAt,
      ).not.toBeNull();
      expect(
        await db.finding.findFirst({
          where: {
            installationId: B,
            source: "CREDENTIAL",
            ruleKey: "azure:credential-revoked",
            status: "OPEN",
          },
        }),
      ).not.toBeNull();
    });

    it("uses login.microsoftonline.com only for service principals", async () => {
      await connectB();
      await runStep();
      expect(az.calls.some((c) => c.host === "login.microsoftonline.com")).toBe(
        false,
      );
    });
  });

  // ---------- M7.2 sync ----------

  describe("sync (step z)", () => {
    beforeEach(async () => {
      await connectB();
      await db.azureDevOpsProject.updateMany({
        where: { installationId: B, id: { not: P1 } },
        data: { selected: false },
      });
    });

    it("shows a queued build after one lazy pass and its jobs and stats once it finished", async () => {
      await runStep();
      const b = az.addBuild({
        definitionId: 3,
        status: "notStarted",
        queuedAt: Date.now() - 2 * MIN,
      });
      const fast = await runStep({ mode: "fast", budgetMs: 8_000 });
      expect(fast.status).toBe("ok");
      expect(
        await db.azureBuild.findFirst({
          where: { installationId: B, id: b.id },
        }),
      ).toMatchObject({ status: "NOT_STARTED" });
      az.advance(b.id, "completed", "succeeded");
      await runStep({ mode: "fast" });
      const row = await db.azureBuild.findFirstOrThrow({
        where: { installationId: B, id: b.id },
      });
      expect(row).toMatchObject({
        status: "COMPLETED",
        result: "SUCCEEDED",
        maxAttempt: 1,
        firstAttemptResult: "SUCCEEDED",
      });
      expect(
        await db.azureBuildJob.count({
          where: { installationId: B, buildId: b.id, type: "Job" },
        }),
      ).toBe(1);
      const stat = await db.dailyPipelineStat.findFirstOrThrow({
        where: { installationId: B, definitionId: 3 },
      });
      expect(stat).toMatchObject({
        builds: 1,
        succeeded: 1,
        firstTrySuccess: 1,
      });
    });

    it("stores only linked definitions and no identities, e-mail addresses or links", async () => {
      az.addBuild({ definitionId: 3, queuedAt: Date.now() - 30 * MIN });
      az.addBuild({ definitionId: 4, queuedAt: Date.now() - 20 * MIN });
      await runStep();
      expect(await db.azureBuild.count({ where: { installationId: B } })).toBe(
        1,
      );
      const tables = [
        "AzureBuild",
        "AzureBuildJob",
        "AzurePipelineDefinition",
        "AzureDevOpsProject",
        "AzurePool",
        "AzureAgent",
        "AzureJobRequest",
        "AuditLog",
        "Finding",
        "AzureDevOpsConnection",
      ];
      for (const t of tables) {
        const rows = await db.$queryRawUnsafe<Array<{ t: string }>>(
          `SELECT row_to_json(x)::text AS t FROM "${t}" x`,
        );
        const dump = rows.map((r) => r.t).join("\n");
        expect(dump, t).not.toContain(PII_EMAIL);
        expect(dump, t).not.toContain(PII_NAME);
        expect(dump, t).not.toContain("evil.example.com");
      }
    });

    it("counts a retried build as flaky-recovered and catches the retry of a finished build in the sweep", async () => {
      const b = az.addBuild({
        definitionId: 3,
        queuedAt: Date.now() - 6 * 3_600_000,
        result: "failed",
        jobs: [
          { name: "build", result: "succeeded" },
          { name: "test", result: "failed" },
        ],
      });
      await runStep();
      expect(
        await db.azureBuild.findFirstOrThrow({
          where: { installationId: B, id: b.id },
        }),
      ).toMatchObject({ result: "FAILED", maxAttempt: 1 });
      az.retry(b.id, "succeeded");
      // The build is completed and older than the cursor: only the z2c sweep sees it.
      await db.azureDevOpsConnection.updateMany({
        where: { installationId: B },
        data: { sweepAt: new Date(Date.now() - 31 * MIN) },
      });
      az.calls.length = 0;
      await runStep();
      expect(
        az
          .callsTo("/_apis/build/builds")
          .some((c) => c.query.statusFilter === "completed"),
      ).toBe(true);
      const row = await db.azureBuild.findFirstOrThrow({
        where: { installationId: B, id: b.id },
      });
      expect(row).toMatchObject({
        result: "SUCCEEDED",
        maxAttempt: 2,
        firstAttemptResult: "FAILED",
      });
      expect(
        await db.azureBuildJob.count({
          where: { installationId: B, buildId: b.id, type: "Job", attempt: 2 },
        }),
      ).toBe(1);
      expect(
        await db.azureBuildJob.count({
          where: { installationId: B, buildId: b.id, type: "Job", attempt: 1 },
        }),
      ).toBe(2);
      const stat = await db.dailyPipelineStat.findFirstOrThrow({
        where: { installationId: B, definitionId: 3 },
      });
      expect(stat).toMatchObject({
        succeeded: 1,
        flakyRecovered: 1,
        firstTrySuccess: 0,
      });
    });

    it("moves the cursor only on a complete chain and resumes a broken one without duplicates or gaps", async () => {
      await db.azureDevOpsProject.updateMany({
        where: { installationId: B },
        data: { selected: true },
      });
      const now = Date.now();
      for (let i = 0; i < 250; i++)
        az.addBuild({
          projectId: [P1, P2, P3][i % 3]!,
          definitionId: [3, 5, 6][i % 3]!,
          queuedAt: now - 40 * 3_600_000 + i * 9 * MIN,
        });
      // A deadline cut after a few pages: every page costs 3 s of fake time.
      let clock = Date.now();
      const passes: string[] = [];
      for (let pass = 0; pass < 120; pass++) {
        const d = new budget.Deadline(clock + 8_000, () => clock);
        // The first passes are cut by the deadline, the later ones finish the chains.
        const cost = pass < 3 ? 3_000 : 100;
        az.onRequest = () => {
          clock += cost;
        };
        const r = await step.runAzureStep({
          installationId: B,
          timezone: "UTC",
          retentionDays: 90,
          deadline: d,
          fetch: az.fetch(),
          envCredential: null,
          budgetMs: 8_000,
        });
        passes.push(r.status);
        const open = await db.azureDevOpsProject.count({
          where: { installationId: B, buildsContinuation: { not: null } },
        });
        if (r.status === "ok" && open === 0) break;
        clock += 1_000;
      }
      az.onRequest = undefined;
      expect(passes[0]).toBe("partial");
      expect(passes.at(-1)).toBe("ok");
      expect(await db.azureBuild.count({ where: { installationId: B } })).toBe(
        250,
      );
      const ids = (
        await db.azureBuild.findMany({
          where: { installationId: B },
          select: { id: true },
        })
      ).map((x) => x.id);
      expect(new Set(ids).size).toBe(250);
      for (const p of await db.azureDevOpsProject.findMany({
        where: { installationId: B },
      })) {
        expect(p.buildsContinuation).toBeNull();
        expect(p.buildsCursor).not.toBeNull();
      }
    });

    it("stops at the request cap of a pass", async () => {
      const now = Date.now();
      for (let i = 0; i < 40; i++)
        az.addBuild({
          definitionId: 3,
          queuedAt: now - 3 * 3_600_000 + i * MIN,
        });
      az.calls.length = 0;
      const r = await runStep();
      expect(
        az.calls.filter((c) => c.host === "dev.azure.com").length,
      ).toBeLessThanOrEqual(80);
      expect(["ok", "partial"]).toContain(r.status);
    });

    it("revokes on 401 and makes no further calls until a rotate", async () => {
      az.pats.get(PAT)!.revoked = true;
      expect((await runStep()).status).toBe("credential_error");
      az.calls.length = 0;
      expect((await runStep()).status).toBe("credential_error");
      expect(az.calls).toHaveLength(0);
      expect(
        await db.finding.count({
          where: {
            installationId: B,
            ruleKey: "azure:credential-revoked",
            status: "OPEN",
          },
        }),
      ).toBe(1);
    });

    it("pauses on Retry-After even on a 200, on TF400733 and on low headroom", async () => {
      await runStep();
      const mine = az.projects
        .filter((p) => p.org === FAKE_ORG)
        .map((p) => ({ ...p, state: "wellFormed" }));
      az.failNext(
        "/_apis/projects",
        200,
        { count: mine.length, value: mine },
        { "retry-after": "120" },
      );
      const r = await runStep({ forceDefinitions: true });
      expect(r.status).toBe("rate_limited");
      const c = await db.azureDevOpsConnection.findUniqueOrThrow({
        where: { installationId: B },
      });
      expect(c.pausedUntil!.getTime()).toBeGreaterThan(Date.now() + 60_000);
      az.calls.length = 0;
      expect((await runStep()).status).toBe("rate_limited");
      expect(az.calls).toHaveLength(0);
      await db.azureDevOpsConnection.updateMany({
        where: { installationId: B },
        data: { pausedUntil: null },
      });
      az.failNext("/_apis/build/builds", 503, {
        message: "TF400733: The request has been canceled: Request was blocked",
      });
      az.addBuild({ definitionId: 3, queuedAt: Date.now() - MIN });
      expect((await runStep()).status).toBe("rate_limited");
      await db.azureDevOpsConnection.updateMany({
        where: { installationId: B },
        data: { pausedUntil: null },
      });
      az.everyResponseHeaders = {
        "x-ratelimit-limit": "200",
        "x-ratelimit-remaining": "10",
        "x-ratelimit-reset": String(Math.round(Date.now() / 1000) + 300),
      };
      expect((await runStep()).status).toBe("rate_limited");
      const rate = await db.installationRateLimit.findUniqueOrThrow({
        where: {
          installationId_resource: { installationId: B, resource: "azure" },
        },
      });
      expect(rate).toMatchObject({ limit: 200, remaining: 10 });
    });

    it("backfills down to the retention with at most half of the budget", async () => {
      const now = Date.now();
      for (let i = 0; i < 30; i++)
        az.addBuild({ definitionId: 3, queuedAt: now - (3 + i) * DAY });
      for (let pass = 0; pass < 5; pass++) await runStep({ retentionDays: 10 });
      const rows = await db.azureBuild.findMany({
        where: { installationId: B },
        select: { queuedAt: true },
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.every((r) => r.queuedAt.getTime() >= now - 10 * DAY - MIN),
      ).toBe(true);
      expect(
        (
          await db.azureDevOpsProject.findFirstOrThrow({
            where: { installationId: B, id: P1 },
          })
        ).backfillDone,
      ).toBe(true);
    });

    it("keeps at least 35 s of a 60 s Sync now for GitHub", async () => {
      await db.vercelConnection
        .create({
          data: {
            installationId: B,
            teamId: "team_testZZZZZZZZZZZZ",
            teamSlug: "team-z",
            teamName: "Team Z",
            tokenSource: "DB",
            accessToken: null,
            createdByUserId: "t",
          },
        })
        .catch(() => undefined);
      const now = Date.now();
      for (let i = 0; i < 200; i++)
        az.addBuild({
          definitionId: 3,
          queuedAt: now - 3 * 3_600_000 + i * 30_000,
        });
      let clock = Date.now();
      az.onRequest = () => {
        clock += 4_000;
      };
      gh.clock = () => clock;
      let githubStartedAt: number | null = null;
      const clients = gh.clients();
      const wrapped = {
        ...clients,
        installation: async (
          ...args: Parameters<typeof clients.installation>
        ) => {
          githubStartedAt ??= clock;
          return clients.installation(...args);
        },
      };
      const d = new budget.Deadline(clock + 60_000, () => clock);
      const startedAt = clock;
      await reconcile.runReconcile({
        deadline: d,
        clients: wrapped,
        installationId: B,
        preclaimed: true,
        azure: { fetch: az.fetch(), envCredential: null },
        vercel: { envToken: null },
      });
      expect(githubStartedAt).not.toBeNull();
      expect(startedAt + 60_000 - githubStartedAt!).toBeGreaterThanOrEqual(
        35_000,
      );
    });
  });

  // ---------- parity ----------

  describe("rollup parity", () => {
    it("gives the same stats as the GitHub rollup for the same scenario", async () => {
      await connectB();
      const day = "2026-11-10";
      const at = (h: number) =>
        new Date(`${day}T${String(h).padStart(2, "0")}:00:00Z`);
      // conclusion, durationS, queueS, attempts, first attempt failed
      const scenario: Array<[string, number, number, number, boolean]> = [
        ["SUCCESS", 300, 10, 1, false],
        ["SUCCESS", 420, 40, 2, true],
        ["FAILURE", 180, 5, 1, false],
        ["CANCELLED", 60, 1, 1, false],
        ["SUCCESS", 900, 300, 1, false],
      ];
      const repo = 22n;
      await db.azurePipelineDefinition.create({
        data: {
          installationId: B,
          projectId: P1,
          id: 3,
          name: "ci",
          repoType: "GitHub",
          repositoryId: repo,
        },
      });
      for (const [
        i,
        [conclusion, dur, queue, attempts, firstFailed],
      ] of scenario.entries()) {
        const created = at(i + 1);
        const started = new Date(created.getTime() + queue * 1000);
        await db.workflowRun.create({
          data: {
            id: BigInt(70_000 + i),
            installationId: B,
            repositoryId: repo,
            workflowId: 501n,
            workflowName: "CI",
            headSha: "a".repeat(40),
            status: "COMPLETED",
            statusRank: 4,
            conclusion: conclusion as "SUCCESS",
            runAttempt: attempts,
            firstAttemptConclusion: (firstFailed
              ? "FAILURE"
              : conclusion) as "SUCCESS",
            createdAt: created,
            runStartedAt: started,
            completedAt: new Date(started.getTime() + dur * 1000),
            durationS: dur,
            source: "RECONCILE",
            lastEventAt: created,
          },
        });
        await db.workflowJob.create({
          data: {
            id: BigInt(80_000 + i),
            runId: BigInt(70_000 + i),
            runAttempt: attempts,
            installationId: B,
            repositoryId: repo,
            workflowId: 501n,
            workflowName: "CI",
            name: "build",
            baseName: "build",
            labels: [],
            labelKey: "",
            status: "COMPLETED",
            statusRank: 4,
            conclusion: conclusion as "SUCCESS",
            runnerName: "runner-1",
            createdAt: created,
            startedAt: started,
            completedAt: new Date(started.getTime() + dur * 1000),
            queueS: queue,
            durationS: dur,
            source: "RECONCILE",
            lastEventAt: created,
          },
        });
        const result =
          conclusion === "SUCCESS"
            ? "SUCCEEDED"
            : conclusion === "FAILURE"
              ? "FAILED"
              : "CANCELED";
        await db.azureBuild.create({
          data: {
            installationId: B,
            id: 90_000 + i,
            projectId: P1,
            definitionId: 3,
            repositoryId: repo,
            buildNumber: String(i),
            status: "COMPLETED",
            result,
            reason: "push",
            queuedAt: created,
            startedAt: started,
            finishedAt: new Date(started.getTime() + dur * 1000),
            durationS: dur,
            queueS: queue,
            maxAttempt: attempts,
            firstAttemptResult: firstFailed ? "FAILED" : result,
            syncedAt: created,
          },
        });
      }
      const { rollupPartition } = await import("@/server/ingest/rollup");
      await rollupPartition(B, repo, day, "UTC");
      await rollup.rollupPipelineDays(B, "UTC", [day]);
      const g = await db.dailyWorkflowStat.findFirstOrThrow({
        where: { installationId: B, workflowId: 501n },
      });
      const a = await db.dailyPipelineStat.findFirstOrThrow({
        where: { installationId: B, definitionId: 3 },
      });
      expect(a.builds).toBe(g.runs);
      expect(a.succeeded).toBe(g.success);
      expect(a.failed + a.partial + a.timedOut).toBe(g.failure);
      expect(a.canceled).toBe(g.cancelled);
      expect(a.firstTrySuccess).toBe(g.firstTrySuccess);
      expect(a.flakyRecovered).toBe(g.flakyRecovered);
      expect(a.durationHist).toEqual(g.durHist);
      expect(a.queueHist).toEqual(g.queueHist);
      expect(Number(a.durSumS)).toBe(Number(g.durSumS));
      const { pipelineSummary } = await import("@/lib/azure-view");
      const { successRate, firstTrySuccessRate, flakyRate } =
        await import("@/server/metrics/stats");
      const { histogramPercentile } =
        await import("@/server/metrics/histogram");
      const s = pipelineSummary([a]);
      expect(s.successRate).toBe(successRate(g));
      expect(s.firstTrySuccessRate).toBe(firstTrySuccessRate(g));
      expect(s.flakyRate).toBe(flakyRate(g));
      expect(s.p95).toBe(histogramPercentile(g.durHist, 0.95));
      expect(s.queueP95).toBe(histogramPercentile(g.queueHist, 0.95));
    });
  });

  // ---------- M7.3 usage, costs, findings ----------

  describe("usage and findings", () => {
    beforeEach(async () => {
      await connectB();
    });

    const request = (
      id: number,
      minutes: number,
      at: number,
      over: Record<string, unknown> = {},
    ) => ({
      requestId: id,
      poolId: 9,
      queueTime: new Date(at - 60_000).toISOString(),
      assignTime: new Date(at).toISOString(),
      finishTime: new Date(at + minutes * 60_000 - 1000).toISOString(),
      result: "succeeded",
      jobId: `00000000-0000-4000-9000-${id.toString(16).padStart(12, "0")}`,
      scopeId: P1,
      owner: { id: 1, name: PII_NAME },
      agentSpecification: { VMImage: "macOS-14" },
      ...over,
    });

    it("counts org-wide job requests, including unlinked definitions and unselected projects", async () => {
      const now = Date.now();
      az.jobRequests.set(9, [
        request(1, 30, now - 2 * 3_600_000),
        request(2, 20, now - 3 * 3_600_000, {
          definition: { id: 4 },
          scopeId: "00000000-0000-4000-8000-000000000099",
        }),
        request(3, 10, now - 4 * 3_600_000, { scopeId: P2 }),
      ]);
      await runStep();
      expect(
        await db.azureJobRequest.count({ where: { installationId: B } }),
      ).toBe(3);
      const usage = (await data.getAzureUsage(actor("VIEWER").scope, B))!;
      expect(usage.estimate).toBe(50);
      expect(usage.publicMinutes).toBe(10);
      expect(usage.osSplit.macos).toBe(60);
      expect(json(await db.azureJobRequest.findMany())).not.toContain(PII_NAME);
    });

    it("labels API and estimate, notes a difference over 5 % and falls back without job requests", async () => {
      const now = Date.now();
      az.jobRequests.set(9, [request(1, 100, now - 3 * 3_600_000)]);
      az.usage.usedMinutes = 130;
      await runStep();
      let u = (await data.getAzureUsage(actor("VIEWER").scope, B))!;
      expect(u).toMatchObject({
        used: 130,
        source: "api",
        estimate: 100,
        differs: true,
      });
      az.jobRequestsMode = "not_found";
      az.resourceUsage = "changed";
      await db.azureDevOpsConnection.updateMany({
        where: { installationId: B },
        data: { poolsSampledAt: null, usageSyncedAt: null },
      });
      await db.azureUsageSnapshot.deleteMany();
      await runStep();
      u = (await data.getAzureUsage(actor("VIEWER").scope, B))!;
      expect(u.partial).toBe(true);
      expect(u.source).toBe("estimate");
    });

    it("raises the minutes finding at 80 % and 100 % and resolves it at the month rollover", async () => {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const put = (minutes: number) =>
        db.dailyAzureUsage.upsert({
          where: {
            installationId_day: {
              installationId: B,
              day: new Date(`${today}T00:00:00Z`),
            },
          },
          create: {
            installationId: B,
            day: new Date(`${today}T00:00:00Z`),
            hostedMinutesPrivate: minutes,
            hostedMinutesPublic: 0,
            hostedMinutesMacos: 0,
            hostedMinutesLinux: minutes,
            hostedMinutesWindows: 0,
            peakParallel: 1,
            saturatedS: 0,
            jobsQueuedOver10m: 0,
          },
          update: { hostedMinutesPrivate: minutes },
        });
      const { updateAzureFindings } =
        await import("@/server/ingest/azure-findings");
      await put(1500);
      await updateAzureFindings(B, "UTC", now);
      const key = `azure:minutes:${today.slice(0, 7)}`;
      expect(
        await db.finding.findFirstOrThrow({
          where: { installationId: B, ruleKey: key },
        }),
      ).toMatchObject({ severity: "MEDIUM", status: "OPEN" });
      await put(1800);
      await updateAzureFindings(B, "UTC", now);
      expect(
        await db.finding.findFirstOrThrow({
          where: { installationId: B, ruleKey: key },
        }),
      ).toMatchObject({ severity: "HIGH" });
      const nextMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2),
      );
      await updateAzureFindings(B, "UTC", nextMonth);
      expect(
        await db.finding.findFirstOrThrow({
          where: { installationId: B, ruleKey: key },
        }),
      ).toMatchObject({ status: "FIXED" });
      // Paid tier: no minutes finding, the usage page says unlimited.
      await mgmt.updateAzureLimits(
        actor("ADMIN"),
        {
          installationId: B,
          limits: {
            hostedParallelJobs: 2,
            includedMinutes: null,
            maxJobMinutes: 360,
            monthResetDay: 1,
            blockWhenQuotaExhausted: false,
          },
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      await updateAzureFindings(B, "UTC", now);
      expect(
        await db.finding.count({
          where: { installationId: B, ruleKey: key, status: "OPEN" },
        }),
      ).toBe(0);
      expect(
        (await data.getAzureUsage(actor("VIEWER").scope, B))!,
      ).toMatchObject({ paid: true, level: "unlimited" });
    });

    it("raises the job-cap finding at a p90 over 50 minutes and the unlinked and pool findings", async () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++)
        az.addBuild({
          definitionId: 3,
          queuedAt: now - (i + 1) * 3_600_000,
          durationS: 3100,
          jobs: [{ name: "e2e", durationS: 3100 }],
        });
      az.agents.set(12, [
        { id: 1, name: "agent-1", status: "offline", enabled: true },
      ]);
      az.jobRequests.set(12, [
        {
          requestId: 99,
          poolId: 12,
          queueTime: new Date(now - 5 * MIN).toISOString(),
          scopeId: P1,
        },
      ]);
      await runStep();
      await runStep();
      const keys = (
        await db.finding.findMany({
          where: { installationId: B, status: "OPEN" },
        })
      ).map((f) => f.ruleKey);
      expect(keys).toContain(`azure:job-cap:${P1}:3`);
      expect(keys).toContain(`azure:definition-unlinked:${P1}:4`);
      expect(keys).toContain("azure:pool-offline:12");
    });

    it("adopts the detected limits, audited", async () => {
      az.usage = {
        ...az.usage,
        totalCount: 3,
        totalMinutes: 0,
        isPremium: true,
      };
      await runStep();
      const r = await mgmt.updateAzureLimits(
        actor("ADMIN"),
        {
          installationId: B,
          adopt: true,
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      expect(r).toMatchObject({
        status: "succeeded",
        data: {
          hostedParallelJobs: 3,
          includedMinutes: null,
          maxJobMinutes: 360,
        },
      });
      expect(
        await db.auditLog.findFirstOrThrow({
          where: { action: "ADO_LIMITS_UPDATE" },
        }),
      ).toMatchObject({ status: "SUCCEEDED" });
    });

    it("leaves the GitHub costs byte-identical and uses the SkuRate multiplier for the macOS card", async () => {
      const { getCosts, parseMonth } = await import("@/server/data/costs");
      const { ensureSkuRates } =
        await import("@/server/ingest/sku-rates").catch(() => ({
          ensureSkuRates: null,
        }));
      if (ensureSkuRates) await (ensureSkuRates as () => Promise<unknown>)();
      const month = parseMonth(null, new Date());
      const before = json(
        await getCosts(
          actor("ADMIN").scope,
          B,
          month,
          new Date("2026-11-13T12:00:00Z"),
        ),
      );
      const now = Date.now();
      az.jobRequests.set(9, [request(1, 100, now - 3 * 3_600_000)]);
      for (let i = 0; i < 3; i++)
        az.addBuild({
          definitionId: 3,
          queuedAt: now - (i + 1) * 3_600_000,
          jobs: [{ name: "build_ios", worker: "Azure Pipelines 3" }],
        });
      await runStep();
      const after = json(
        await getCosts(
          actor("ADMIN").scope,
          B,
          month,
          new Date("2026-11-13T12:00:00Z"),
        ),
      );
      expect(after).toBe(before);
      const c = (await data.getAzureCosts(actor("ADMIN").scope, B, month))!;
      const rate = await db.skuRate.findFirst({
        where: { sku: "macos" },
        orderBy: { effectiveFrom: "desc" },
      });
      expect(c.macosMultiplier).toBe(rate ? Number(rate.minuteMultiplier) : 10);
    });
  });

  // ---------- M7.4 hints and service hook ----------

  describe("hints and service hook", () => {
    beforeEach(async () => {
      await connectB(PAT_EXEC);
      await runStep();
    });

    it("refreshes a hinted build with at most 3 calls and ignores other app slugs", async () => {
      const b = az.addBuild({
        definitionId: 3,
        status: "inProgress",
        queuedAt: Date.now() - 5 * MIN,
      });
      const details = `https://dev.azure.com/${FAKE_ORG}/${P1}/_build/results?buildId=${b.id}`;
      expect(
        await hints.foldCheckHint(
          B,
          "check_run",
          {
            repository: { id: 22 },
            check_run: { app: { slug: "other-ci" }, details_url: details },
          },
          new Date(),
        ),
      ).toBeNull();
      const hint = await hints.foldCheckHint(
        B,
        "check_run",
        {
          repository: { id: 22 },
          check_run: { app: { slug: "azure-pipelines" }, details_url: details },
        },
        new Date(),
      );
      expect(hint!.builds).toEqual([{ projectId: P1, buildId: b.id }]);
      az.calls.length = 0;
      const startedAt = Date.now();
      await hints.refreshAzureBuilds(B, hint!.builds, { fetch: az.fetch() });
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(
        az.calls.filter((c) => c.host === "dev.azure.com").length,
      ).toBeLessThanOrEqual(3);
      expect(
        await db.azureBuild.findFirst({
          where: { installationId: B, id: b.id },
        }),
      ).toMatchObject({ status: "IN_PROGRESS" });
      // Debounced: a second hint within 30 s makes no call.
      az.calls.length = 0;
      await hints.refreshAzureBuilds(B, hint!.builds, { fetch: az.fetch() });
      expect(az.calls).toHaveLength(0);
      // A repository of another installation is never hinted.
      expect(
        await hints.foldCheckHint(
          A,
          "check_run",
          {
            repository: { id: 22 },
            check_run: {
              app: { slug: "azure-pipelines" },
              details_url: details,
            },
          },
          new Date(),
        ),
      ).toBeNull();
    });

    it("creates subscriptions, verifies deliveries with the real store and raises a finding for a disabled one", async () => {
      const r = await mgmt.installAzureHooks(
        actor("ADMIN"),
        {
          installationId: B,
          mode: "auto",
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      expect(r).toMatchObject({ status: "succeeded", data: { mode: "auto" } });
      const setup = (
        r as {
          data: {
            url: string;
            username: string;
            password: string;
            subscriptions: number;
          };
        }
      ).data;
      expect(setup.subscriptions).toBeGreaterThan(0);
      const audit = await db.auditLog.findFirstOrThrow({
        where: { action: "ADO_HOOKS_INSTALL" },
      });
      expect(json(audit)).not.toContain(setup.password);
      const conn = await db.azureDevOpsConnection.findUniqueOrThrow({
        where: { installationId: B },
      });
      expect(conn.hookSecret).not.toContain(setup.password);
      const auth = `Basic ${Buffer.from(`${setup.username}:${setup.password}`).toString("base64")}`;
      const b = az.addBuild({ definitionId: 3, queuedAt: Date.now() - MIN });
      await runStep({ mode: "fast" });
      const env = (id: number, org = FAKE_ORG_ID) =>
        json({
          notificationId: id,
          eventType: "ms.vss-pipelines.run-state-changed-event",
          resourceContainers: { account: { id: org }, project: { id: P1 } },
          resource: { run: { id: b.id } },
        });
      const ok = await hook.handleAzureHook(
        { hookKey: setup.username, authorization: auth, body: env(1) },
        hookStore.prismaAzureHookStore,
      );
      expect(ok.status).toBe(200);
      expect(
        (
          await db.azureBuild.findFirstOrThrow({
            where: { installationId: B, id: b.id },
          })
        ).dirtyAt,
      ).not.toBeNull();
      expect(
        (
          await hook.handleAzureHook(
            { hookKey: setup.username, authorization: auth, body: env(1) },
            hookStore.prismaAzureHookStore,
          )
        ).body,
      ).toEqual({ result: "duplicate" });
      expect(
        (
          await hook.handleAzureHook(
            {
              hookKey: setup.username,
              authorization: auth,
              body: env(2, "00000000-0000-4000-8000-000000000099"),
            },
            hookStore.prismaAzureHookStore,
          )
        ).status,
      ).toBe(403);
      for (let i = 0; i < 11; i++)
        await hook.handleAzureHook(
          {
            hookKey: setup.username,
            authorization: "Basic eDp5",
            body: env(10 + i),
          },
          hookStore.prismaAzureHookStore,
        );
      expect(
        (
          await hook.handleAzureHook(
            { hookKey: setup.username, authorization: auth, body: env(30) },
            hookStore.prismaAzureHookStore,
          )
        ).status,
      ).toBe(429);
      // A subscription Azure DevOps disabled raises a finding (z6).
      az.subscriptions[0]!.status = "disabledBySystem";
      await db.azureDevOpsConnection.updateMany({
        where: { installationId: B },
        data: { hooksCheckedAt: null, hookBlockedUntil: null },
      });
      await runStep();
      expect(
        await db.finding.count({
          where: {
            installationId: B,
            ruleKey: { startsWith: "azure:hook-disabled:" },
            status: "OPEN",
          },
        }),
      ).toBe(1);
      // Rotation: the previous secret still works within its window.
      const rot = await mgmt.rotateAzureHookSecret(
        actor("ADMIN"),
        { installationId: B, confirmed: true, idempotencyKey: randomUUID() },
        deps(),
      );
      expect(rot.status).toBe("succeeded");
      expect(
        (
          await hook.handleAzureHook(
            { hookKey: setup.username, authorization: auth, body: env(40) },
            hookStore.prismaAzureHookStore,
          )
        ).status,
      ).toBe(200);
    });

    it("converges by polling with hooks and hints off", async () => {
      const b = az.addBuild({
        definitionId: 3,
        status: "inProgress",
        queuedAt: Date.now() - 5 * MIN,
      });
      await runStep();
      az.advance(b.id, "completed", "failed");
      await runStep();
      expect(
        await db.azureBuild.findFirstOrThrow({
          where: { installationId: B, id: b.id },
        }),
      ).toMatchObject({ status: "COMPLETED", result: "FAILED" });
    });
  });

  // ---------- M7.5 unified views ----------

  describe("unified views", () => {
    it("merges GitHub runs and Azure builds by time, filters by provider and joins pull requests by SHA and number", async () => {
      await connectB();
      const now = Date.now();
      const pr = {
        number: 7,
        sourceSha: "c".repeat(40),
        sourceBranch: "feature/x",
      };
      az.addBuild({
        definitionId: 3,
        queuedAt: now - 10 * MIN,
        sha: "d".repeat(40),
      });
      az.addBuild({ definitionId: 3, queuedAt: now - 30 * MIN, pr });
      await runStep();
      await db.workflowRun.create({
        data: {
          id: 71_000n,
          installationId: B,
          repositoryId: 22n,
          workflowId: 501n,
          workflowName: "CI",
          headSha: "e".repeat(40),
          status: "COMPLETED",
          statusRank: 4,
          conclusion: "SUCCESS",
          createdAt: new Date(now - 20 * MIN),
          source: "RECONCILE",
          lastEventAt: new Date(now),
        },
      });
      const scope = actor("VIEWER").scope;
      const all = await ci.listCiRuns(scope, B, {});
      expect(all.runs.map((r) => r.provider)).toEqual([
        "azure",
        "github",
        "azure",
      ]);
      expect(
        (await ci.listCiRuns(scope, B, { provider: "github" })).runs.map(
          (r) => r.provider,
        ),
      ).toEqual(["github"]);
      expect(
        (
          await ci.listCiRuns(scope, B, {
            provider: "azure",
            repositoryId: 22n,
          })
        ).runs,
      ).toHaveLength(2);
      expect(
        (await ci.listCiRuns(scope, B, { actor: "example-user" })).runs.every(
          (r) => r.provider === "github",
        ),
      ).toBe(true);
      const page1 = await ci.listCiRuns(scope, B, { limit: 2 });
      const page2 = await ci.listCiRuns(scope, B, {
        limit: 2,
        before: page1.next!,
      });
      expect([...page1.runs, ...page2.runs].map((r) => r.id)).toEqual(
        all.runs.map((r) => r.id),
      );
      const prs = await data.azureBuildsForPulls(
        scope,
        B,
        [
          { repositoryId: "22", number: 7, headSha: "f".repeat(40) },
          { repositoryId: "22", number: 99, headSha: "d".repeat(40) },
        ],
        (id) => `/x/${id}`,
      );
      expect(Object.keys(prs).sort()).toEqual(["22:7", "22:99"]);
      // Another installation sees none of it.
      await expect(
        ci.listCiRuns(actor("VIEWER", [A]).scope, B, {}),
      ).rejects.toThrow();
      expect(
        (await ci.listCiRuns(actor("VIEWER").scope, A, {})).runs,
      ).toHaveLength(0);
      // An ignored repository drops out of the union.
      await db.repository.updateMany({
        where: { id: 22n },
        data: { ignoredAt: new Date() },
      });
      expect((await ci.listCiRuns(scope, B, {})).runs).toHaveLength(0);
    });
  });

  // ---------- M7b actions ----------

  describe("actions (M7b)", () => {
    let failed: number;
    let running: number;
    beforeEach(async () => {
      await connectB(PAT_EXEC);
      await db.azureDevOpsProject.updateMany({
        where: { installationId: B, id: { not: P1 } },
        data: { selected: false },
      });
      failed = az.addBuild({
        definitionId: 3,
        queuedAt: Date.now() - 60 * MIN,
        result: "failed",
        jobs: [{ name: "build", result: "failed" }],
      }).id;
      running = az.addBuild({
        definitionId: 3,
        status: "inProgress",
        queuedAt: Date.now() - 5 * MIN,
      }).id;
      await runStep();
      const t = await actions.setAzureManagementEnabled(
        actor("ADMIN"),
        {
          installationId: B,
          enabled: true,
          typed: FAKE_ORG,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      expect(t).toMatchObject({ status: "succeeded", data: { enabled: true } });
    });

    const act = (
      op: "cancel" | "retry" | "retryStage",
      buildId: number,
      role: Role = "OPERATOR",
      over: Record<string, unknown> = {},
      stage?: string,
    ) =>
      actions.performAzureBuildAction(
        actor(role),
        {
          installationId: B,
          buildId,
          operation: op,
          stage,
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(over),
      );

    it("answers every closed gate with its reason and a DENIED row", async () => {
      expect(
        await act("cancel", running, "OPERATOR", { managementEnabled: false }),
      ).toEqual({
        status: "unavailable",
        reason: "management_disabled_global",
      });
      expect(
        await act("cancel", running, "OPERATOR", {
          azureManagementEnabled: false,
        }),
      ).toEqual({
        status: "unavailable",
        reason: "azure_management_disabled_global",
      });
      await db.installation.updateMany({
        where: { id: B },
        data: { managementEnabled: false },
      });
      expect(await act("cancel", running)).toEqual({
        status: "unavailable",
        reason: "management_disabled_installation",
      });
      await db.installation.updateMany({
        where: { id: B },
        data: { managementEnabled: true },
      });
      await db.azureDevOpsConnection.updateMany({
        where: { installationId: B },
        data: { managementEnabled: false },
      });
      expect(await act("cancel", running)).toEqual({
        status: "unavailable",
        reason: "azure_management_disabled",
      });
      await db.azureDevOpsConnection.updateMany({
        where: { installationId: B },
        data: { managementEnabled: true },
      });
      await db.installationRateLimit.upsert({
        where: {
          installationId_resource: { installationId: B, resource: "azure" },
        },
        create: {
          installationId: B,
          resource: "azure",
          limit: 200,
          remaining: 5,
          resetAt: new Date(Date.now() + 300_000),
          updatedAt: new Date(),
        },
        update: {
          limit: 200,
          remaining: 5,
          resetAt: new Date(Date.now() + 300_000),
        },
      });
      expect(await act("cancel", running)).toEqual({
        status: "unavailable",
        reason: "azure_rate_limited",
      });
      await db.installationRateLimit.deleteMany();
      await db.azureDevOpsConnection.updateMany({
        where: { installationId: B },
        data: { scopes: { execute: "missing" } },
      });
      expect(await act("cancel", running)).toEqual({
        status: "unavailable",
        reason: "azure_scope_missing",
      });
      await db.azureDevOpsConnection.updateMany({
        where: { installationId: B },
        data: { revokedAt: new Date() },
      });
      expect(await act("cancel", running)).toEqual({
        status: "unavailable",
        reason: "azure_revoked",
      });
      expect(await act("cancel", running, "VIEWER")).toEqual({
        status: "forbidden",
      });
      expect(
        await db.auditLog.count({
          where: { action: "ADO_CANCEL", status: "DENIED" },
        }),
      ).toBe(8);
      expect(
        az.callsTo(`/_apis/build/builds/${running}`, "PATCH"),
      ).toHaveLength(0);
    });

    it("cancels, retries, retries a stage and queues a run, each with one audit row and minimal params", async () => {
      expect(await act("cancel", failed)).toEqual({
        status: "refused",
        reason: "not_cancelable",
      });
      expect(await act("cancel", running)).toMatchObject({
        status: "succeeded",
        data: { buildId: running, status: "cancelling" },
      });
      expect(
        await db.azureBuild.findFirstOrThrow({
          where: { installationId: B, id: running },
        }),
      ).toMatchObject({ status: "CANCELLING" });
      expect(await act("retry", failed)).toMatchObject({ status: "succeeded" });
      expect(
        await db.azureBuild.findFirstOrThrow({
          where: { installationId: B, id: failed },
        }),
      ).toMatchObject({ status: "IN_PROGRESS" });
      az.advance(failed, "completed", "failed");
      await runStep();
      expect(
        await act("retryStage", failed, "OPERATOR", {}, "NotAStage"),
      ).toEqual({ status: "refused", reason: "invalid_stage" });
      expect(
        await act("retryStage", failed, "OPERATOR", {}, "Build"),
      ).toMatchObject({ status: "succeeded" });
      expect(
        az.callsTo(`/_apis/build/builds/${failed}/stages/Build`, "PATCH"),
      ).toHaveLength(1);
      const q = await actions.queueAzureRun(
        actor("OPERATOR"),
        {
          installationId: B,
          projectId: P1,
          definitionId: 3,
          branch: "main",
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      expect(q).toMatchObject({ status: "succeeded" });
      const newId = (q as { data: { buildId: number } }).data.buildId;
      const queued = await db.azureBuild.findFirstOrThrow({
        where: { installationId: B, id: newId },
      });
      expect(queued.auditLinkKind).toBe("exact");
      expect(az.builds.find((b) => b.id === newId)!.tags).toEqual([
        `dm-audit-${queued.auditLogId}`,
      ]);
      const rows = await db.auditLog.findMany({
        where: {
          action: {
            in: ["ADO_CANCEL", "ADO_RETRY", "ADO_STAGE_RETRY", "ADO_QUEUE_RUN"],
          },
          status: "SUCCEEDED",
        },
      });
      expect(rows).toHaveLength(4);
      for (const r of rows) {
        expect(
          Object.keys(r.params as object)
            .sort()
            .join(","),
        ).toMatch(
          /^(buildId,definitionId,projectId(,stage)?|definitionId,projectId,refName)$/,
        );
        expect(r.actingAs).toBe(`azure:pat:${PAT_EXEC.slice(-4)}`);
        expect(r.githubRequestId).toMatch(/^fake-activity-/);
      }
      expect(await act("cancel", running, "VIEWER")).toEqual({
        status: "forbidden",
      });
      expect((await auditLog.verifyAuditChain(B)).ok).toBe(true);
    });

    it("records an unknown outcome for a dropped queue and links the build probably", async () => {
      az.dropAfterSend.push("/_apis/pipelines/3/runs");
      const q = await actions.queueAzureRun(
        actor("OPERATOR"),
        {
          installationId: B,
          projectId: P1,
          definitionId: 3,
          branch: "main",
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      expect(q).toMatchObject({ status: "failed" });
      expect((q as { message: string }).message).toMatch(/^outcome_unknown/);
      await runStep();
      const linked = await db.azureBuild.findFirstOrThrow({
        where: { installationId: B, reason: "workflow_dispatch" },
      });
      expect(linked.auditLinkKind).toBe("probable");
      const row = await db.auditLog.findFirstOrThrow({
        where: { installationId: B, action: "ADO_QUEUE_RUN" },
        orderBy: { seq: "desc" },
      });
      // UNKNOWN is a final FAILED row whose error starts with outcome_unknown.
      expect(row.status).toBe("FAILED");
      expect(row.error).toMatch(/^outcome_unknown/);
      expect(linked.auditLogId).toBe(row.id);
      expect((await auditLog.verifyAuditChain(B)).ok).toBe(true);
    });

    it("links a tagged build exactly in the next pass when the link was lost", async () => {
      const q = await actions.queueAzureRun(
        actor("OPERATOR"),
        {
          installationId: B,
          projectId: P1,
          definitionId: 3,
          branch: "main",
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      const id = (q as { data: { buildId: number } }).data.buildId;
      // A crash after the tag write: the stored build and its link are gone.
      await db.azureBuildJob.deleteMany({
        where: { installationId: B, buildId: id },
      });
      await db.azureBuild.deleteMany({ where: { installationId: B, id } });
      await runStep();
      const b = await db.azureBuild.findFirstOrThrow({
        where: { installationId: B, id },
      });
      expect(b.auditLinkKind).toBe("exact");
      expect(az.builds.find((x) => x.id === id)!.tags).toEqual([
        `dm-audit-${b.auditLogId}`,
      ]);
    });

    it("pauses actions while the connection is paused and hides the buttons from viewers", async () => {
      const state = (role: Role) =>
        data.getAzureActionState(actor(role).scope, B, true, true);
      expect(await state("VIEWER")).toMatchObject({
        canAct: false,
        blockedBy: "role",
        canViewLog: false,
      });
      expect(await state("OPERATOR")).toMatchObject({
        canAct: true,
        blockedBy: null,
        canViewLog: true,
        hostedParallelJobs: 1,
      });
      expect(
        await data.getAzureActionState(actor("OPERATOR").scope, B, true, false),
      ).toMatchObject({
        canAct: false,
        blockedBy: "azure_management_disabled_global",
      });
      await db.azureDevOpsConnection.updateMany({
        where: { installationId: B },
        data: { pausedUntil: new Date(Date.now() + 300_000) },
      });
      expect(await state("OPERATOR")).toMatchObject({
        canAct: false,
        blockedBy: "azure_rate_limited",
      });
      expect(await act("cancel", running)).toEqual({
        status: "unavailable",
        reason: "azure_rate_limited",
      });
      await db.azureDevOpsConnection.updateMany({
        where: { installationId: B },
        data: { pausedUntil: null },
      });
      await expect(
        data.getAzureActionState(actor("OPERATOR", [B]).scope, A, true, true),
      ).rejects.toThrow();
    });

    it("refuses queue and retry when the minutes are exhausted and blocking is on", async () => {
      await db.azureDevOpsConnection.updateMany({
        where: { installationId: B },
        data: { blockWhenQuotaExhausted: true, includedMinutes: 1 },
      });
      await db.azureUsageSnapshot.deleteMany({ where: { installationId: B } });
      await db.azureUsageSnapshot.create({
        data: {
          installationId: B,
          month: new Date().toISOString().slice(0, 7),
          source: "api",
          usedMinutes: 5,
          totalParallel: 1,
          usedParallel: 0,
          capturedAt: new Date(),
        },
      });
      expect(
        await actions.queueAzureRun(
          actor("OPERATOR"),
          {
            installationId: B,
            projectId: P1,
            definitionId: 3,
            branch: "main",
            confirmed: true,
            idempotencyKey: randomUUID(),
          },
          deps(),
        ),
      ).toEqual({ status: "refused", reason: "quota_exhausted" });
    });

    it("keeps the toggle off when the execute probe fails", async () => {
      await actions.setAzureManagementEnabled(
        actor("ADMIN"),
        {
          installationId: B,
          enabled: false,
          typed: FAKE_ORG,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      az.pats.get(PAT_EXEC)!.scopes.delete("execute");
      const r = await actions.setAzureManagementEnabled(
        actor("ADMIN"),
        {
          installationId: B,
          enabled: true,
          typed: FAKE_ORG,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      expect(r).toMatchObject({ status: "failed" });
      const c = await db.azureDevOpsConnection.findUniqueOrThrow({
        where: { installationId: B },
      });
      expect(c.managementEnabled).toBe(false);
      expect((c.scopes as Record<string, string>).execute).toBe("missing");
    });

    it("reads a scrubbed, capped log excerpt for operators only and stores nothing of it", async () => {
      for (const m of ["log", "info", "debug"] as const)
        vi.spyOn(console, m).mockImplementation(() => undefined);
      const b = az.builds.find((x) => x.id === failed)!;
      b.logs.set(
        10,
        `2026-11-13T10:00:00.0000000Z using ${PAT_EXEC} in ${FAKE_ORG}\n${"2026-11-13T10:00:01.0000000Z line\n".repeat(500)}`,
      );
      const job = await db.azureBuildJob.findFirstOrThrow({
        where: { installationId: B, buildId: failed, type: "Job" },
      });
      const ex = await actions.getAzureLogExcerpt(
        actor("OPERATOR"),
        {
          installationId: B,
          buildId: failed,
          recordId: job.recordId,
          attempt: job.attempt,
        },
        { now: () => new Date(), azureFetch: az.fetch() },
      );
      expect(ex.status).toBe("ok");
      const text = json(ex);
      const logged = [
        console.log,
        console.info,
        console.warn,
        console.error,
        console.debug,
      ]
        .flatMap((f) =>
          vi.isMockFunction(f) ? f.mock.calls.map((c) => json(c)) : [],
        )
        .join("\n");
      expect(logged).not.toContain(PAT_EXEC);
      expect(logged).not.toContain("line\\n");
      expect(text).not.toContain(PAT_EXEC);
      expect(text).not.toContain(FAKE_ORG + " ");
      expect(
        (ex as { excerpt: { lines: unknown[] } }).excerpt.lines.length,
      ).toBeLessThanOrEqual(200);
      expect(
        await actions.getAzureLogExcerpt(
          actor("VIEWER"),
          {
            installationId: B,
            buildId: failed,
            recordId: job.recordId,
            attempt: job.attempt,
          },
          { now: () => new Date(), azureFetch: az.fetch() },
        ),
      ).toEqual({ status: "forbidden" });
      const dump = (
        await db.$queryRawUnsafe<Array<{ t: string }>>(
          `SELECT row_to_json(x)::text AS t FROM "AzureBuildJob" x`,
        )
      )
        .map((r) => r.t)
        .join("");
      expect(dump).not.toContain("line\\n");
    });

    it("deletes every Azure row on disconnect and keeps the audit rows", async () => {
      await mgmt.installAzureHooks(
        actor("ADMIN"),
        {
          installationId: B,
          mode: "auto",
          confirmed: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      const r = await mgmt.disconnectAzure(
        actor("ADMIN"),
        {
          installationId: B,
          typed: FAKE_ORG,
          deleteHooks: true,
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
      expect(r).toMatchObject({ status: "succeeded" });
      expect(az.subscriptions).toHaveLength(0);
      for (const t of data.AZURE_TABLES) {
        const [row] = await db.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM "${t}" WHERE "installationId" = $1`,
          B,
        );
        expect(row!.n, t).toBe(0);
      }
      expect(
        await db.finding.count({
          where: {
            installationId: B,
            OR: [
              { source: "AZURE_PIPELINES" },
              { ruleKey: { startsWith: "azure:" } },
            ],
          },
        }),
      ).toBe(0);
      expect(
        await db.auditLog.count({
          where: {
            installationId: B,
            action: {
              in: ["ADO_CONNECT", "ADO_DISCONNECT", "ADO_MANAGEMENT_TOGGLE"],
            },
          },
        }),
      ).toBeGreaterThanOrEqual(3);
      expect((await auditLog.verifyAuditChain(B)).ok).toBe(true);
    });
  });
});
