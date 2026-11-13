import { describe, expect, it, vi } from "vitest";
import { buildIdOfCheck, projectOfCheck } from "./azure-hints";
import {
  HOOK_MAX_BYTES,
  handleAzureHook,
  parseBasic,
  secretMatches,
  type AzureHookStore,
  type HookConnection,
} from "./azure-hook";
import { planProviderPhase, remainingProviderBudget } from "./provider-step";
import { redactError } from "./webhook";

vi.mock("@/server/db", () => ({ db: {} }));
vi.mock("@/server/crypto", () => ({ tokenKeyRing: () => ({}) }));

const KEY = "hookkey0123456789abcd";
const SECRET = "hook-secret-not-real-0001"; // gitleaks:allow (test placeholder)
const PREV = "hook-secret-not-real-0000"; // gitleaks:allow (test placeholder)
const ORG = "00000000-0000-4000-8000-000000000001";
const P1 = "00000000-0000-4000-8000-000000000011";
const NOW = new Date("2026-11-13T10:00:00Z");

function store(conn: Partial<HookConnection> = {}) {
  const deliveries = new Set<string>();
  const s = {
    failures: 0,
    dirty: [] as Array<[string, number | null]>,
    security: vi.fn(),
    async findConnection(key: string) {
      return key === KEY
        ? {
            installationId: 2002n,
            orgId: ORG,
            secret: SECRET,
            previousSecret: PREV,
            previousUntil: new Date(NOW.getTime() + 86_400_000),
            blockedUntil: null,
            ...conn,
          }
        : null;
    },
    async recordFailure() {
      s.failures++;
    },
    async isSelectedProject(_: bigint, projectId: string) {
      return projectId === P1;
    },
    async insertDelivery(row: { id: string }) {
      if (deliveries.has(row.id)) return "duplicate" as const;
      deliveries.add(row.id);
      return "inserted" as const;
    },
    async markDirty(_: bigint, projectId: string, buildId: number | null) {
      s.dirty.push([projectId, buildId]);
    },
  };
  return s as typeof s & AzureHookStore;
}

const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    notificationId: 7,
    eventType: "ms.vss-pipelines.run-state-changed-event",
    resourceContainers: { account: { id: ORG }, project: { id: P1 } },
    resource: {
      run: { id: 4100 },
      requestedFor: { uniqueName: "person@example.com" },
    },
    ...over,
  });

describe("service hook route", () => {
  it("accepts the current secret, compares in constant time and only marks the build dirty", async () => {
    const s = store();
    const compare = vi.fn(secretMatches);
    const r = await handleAzureHook(
      { hookKey: KEY, authorization: basic(KEY, SECRET), body: envelope() },
      s,
      { now: () => NOW, compare },
    );
    expect(r.status).toBe(200);
    expect(compare).toHaveBeenCalled();
    expect(s.dirty).toEqual([[P1, 4100]]);
  });

  it("rejects missing, wrong and stale secrets with 401 and counts the failures", async () => {
    const s = store({ previousUntil: new Date(NOW.getTime() - 1) });
    for (const auth of [
      null,
      basic(KEY, "wrong"),
      basic("other-user", SECRET),
      basic(KEY, PREV),
      "Bearer x",
    ]) {
      const r = await handleAzureHook(
        { hookKey: KEY, authorization: auth, body: envelope() },
        s,
        { now: () => NOW },
      );
      expect(r.status).toBe(401);
    }
    expect(s.failures).toBe(5);
    expect(s.dirty).toEqual([]);
  });

  it("accepts the previous secret inside its window", async () => {
    const r = await handleAzureHook(
      { hookKey: KEY, authorization: basic(KEY, PREV), body: envelope() },
      store(),
      { now: () => NOW },
    );
    expect(r.status).toBe(200);
  });

  it("refuses unknown keys, blocked keys, oversize bodies, foreign orgs and other events", async () => {
    expect(
      (
        await handleAzureHook(
          {
            hookKey: "unknownkey0123456789", // gitleaks:allow (test placeholder)
            authorization: basic(KEY, SECRET),
            body: envelope(),
          },
          store(),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleAzureHook(
          { hookKey: KEY, authorization: basic(KEY, SECRET), body: envelope() },
          store({ blockedUntil: new Date(NOW.getTime() + 60_000) }),
          { now: () => NOW },
        )
      ).status,
    ).toBe(429);
    expect(
      (
        await handleAzureHook(
          {
            hookKey: KEY,
            authorization: basic(KEY, SECRET),
            body: "x".repeat(HOOK_MAX_BYTES + 1),
          },
          store(),
        )
      ).status,
    ).toBe(413);
    const s = store();
    const foreign = await handleAzureHook(
      {
        hookKey: KEY,
        authorization: basic(KEY, SECRET),
        body: envelope({
          resourceContainers: {
            account: { id: "00000000-0000-4000-8000-000000000099" },
            project: { id: P1 },
          },
        }),
      },
      s,
      { now: () => NOW },
    );
    expect(foreign.status).toBe(403);
    expect(s.security).toHaveBeenCalled();
    const other = await handleAzureHook(
      {
        hookKey: KEY,
        authorization: basic(KEY, SECRET),
        body: envelope({ eventType: "git.push" }),
      },
      s,
      { now: () => NOW },
    );
    expect(other.status).toBe(202);
    const unselected = await handleAzureHook(
      {
        hookKey: KEY,
        authorization: basic(KEY, SECRET),
        body: envelope({
          resourceContainers: {
            account: { id: ORG },
            project: { id: "00000000-0000-4000-8000-000000000012" },
          },
        }),
      },
      s,
      { now: () => NOW },
    );
    expect(unselected.body).toEqual({ result: "project not selected" });
    expect(s.dirty).toEqual([]);
  });

  it("dedupes on the notification id", async () => {
    const s = store();
    const req = {
      hookKey: KEY,
      authorization: basic(KEY, SECRET),
      body: envelope(),
    };
    expect((await handleAzureHook(req, s, { now: () => NOW })).body).toEqual({
      result: "accepted",
    });
    expect((await handleAzureHook(req, s, { now: () => NOW })).body).toEqual({
      result: "duplicate",
    });
    expect(s.dirty).toHaveLength(1);
  });

  it("parses Basic headers only", () => {
    expect(parseBasic(basic("u", "p:x"))).toEqual({
      user: "u",
      password: "p:x",
    });
    expect(parseBasic("Basic !!")).toBeNull();
  });
});

describe("check run hints", () => {
  it("takes the build id from details_url, then external_id", () => {
    expect(
      buildIdOfCheck(
        "https://dev.azure.com/contoso-ci/00000000-0000-4000-8000-000000000011/_build/results?buildId=4100&view=logs",
        null,
      ),
    ).toBe(4100);
    expect(buildIdOfCheck(null, "3|4101|Build")).toBe(4101);
    expect(
      buildIdOfCheck("https://evil.example.com/?buildId=1'; drop", "nope"),
    ).toBe(null);
    expect(
      projectOfCheck(
        "https://dev.azure.com/contoso-ci/project-a/_build/results?buildId=1",
        "contoso-ci",
      ),
    ).toBe("project-a");
    expect(
      projectOfCheck(
        "https://dev.azure.com/fabrikam/project-a/_build/results?buildId=1",
        "contoso-ci",
      ),
    ).toBeNull();
    expect(
      projectOfCheck("https://evil.example.com/contoso-ci/p", "contoso-ci"),
    ).toBeNull();
  });
});

describe("provider phase", () => {
  it("keeps at least 35 s of a 60 s interactive pass for GitHub", () => {
    for (const providers of [
      [{ provider: "vercel" as const, lastSyncedAt: null }],
      [{ provider: "azure" as const, lastSyncedAt: null }],
      [
        { provider: "vercel" as const, lastSyncedAt: new Date(2) },
        { provider: "azure" as const, lastSyncedAt: new Date(1) },
      ],
    ]) {
      const plan = planProviderPhase("interactive", providers);
      expect(plan.reduce((s, p) => s + p.budgetMs, 0)).toBeLessThanOrEqual(
        25_000,
      );
    }
    expect(
      planProviderPhase("interactive", [
        { provider: "vercel", lastSyncedAt: new Date(2) },
        { provider: "azure", lastSyncedAt: new Date(1) },
      ])[0],
    ).toEqual({ provider: "azure", budgetMs: 15_000 });
    expect(remainingProviderBudget(17_000, 10_000)).toBe(0);
    expect(
      planProviderPhase("cron", [
        { provider: "azure", lastSyncedAt: null },
        { provider: "vercel", lastSyncedAt: null },
      ]),
    ).toEqual([
      { provider: "vercel", budgetMs: 25_000 },
      { provider: "azure", budgetMs: 30_000 },
    ]);
  });
});

describe("redaction", () => {
  it("removes Azure DevOps PATs, JWTs and Basic credentials", () => {
    const pat = `${"Q".repeat(76)}AZDO${"z".repeat(4)}`;
    const out = redactError(
      `failed with ${pat} and Basic ${Buffer.from(":x".repeat(10)).toString("base64")} eyJabcdefgh.ijklmnopq.rstuvwxyz`,
    );
    expect(out).not.toContain(pat);
    expect(out).not.toContain("eyJabcdefgh");
    expect(out).toContain("Basic [redacted]");
  });
});
