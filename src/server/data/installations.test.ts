import { describe, expect, it, vi } from "vitest";
import type { TenantScope } from "@/server/authz/scope";
import {
  findInstallationByAccount,
  listInstallations,
  listRepositories,
  NotFoundError,
  type DataClient,
  type InstallationRow,
  type RepositoryRow,
} from "./installations";

vi.mock("@/server/db", () => ({ db: {} }));

/**
 * Two-installation isolation: a personal account (A) and an organisation (B).
 * The in-memory client implements just the where-clause shapes the data layer
 * uses, so the tests check that the data layer asks for the right rows.
 */

const A = 1001n; // example-user (personal)
const B = 2002n; // example-org (organisation)
const GONE = 3003n; // uninstalled

const inst = (
  id: bigint,
  login: string,
  type: "USER" | "ORGANIZATION",
  extra: Partial<InstallationRow> = {},
): InstallationRow => ({
  id,
  accountLogin: login,
  accountType: type,
  repositorySelection: "ALL",
  permissions: { metadata: "read" },
  suspendedAt: null,
  deletedAt: null,
  lastWebhookAt: null,
  lastReconciledAt: null,
  ...extra,
});

const repo = (
  id: bigint,
  installationId: bigint,
  fullName: string,
  removedAt: Date | null = null,
): RepositoryRow => ({
  id,
  installationId,
  fullName,
  name: fullName.split("/")[1]!,
  private: false,
  archived: false,
  defaultBranch: "main",
  removedAt,
});

const installations = [
  inst(A, "example-user", "USER"),
  inst(B, "example-org", "ORGANIZATION"),
  inst(GONE, "example-gone", "ORGANIZATION", { deletedAt: new Date() }),
];
const repositories = [
  repo(1n, A, "example-user/repo-a"),
  repo(2n, B, "example-org/repo-b"),
  repo(3n, B, "example-org/repo-old", new Date()),
];

type Where = Record<string, unknown>;

function matchesInstallation(row: InstallationRow, where: Where): boolean {
  const idIn = (where.id as { in?: bigint[] } | undefined)?.in;
  if (idIn && !idIn.includes(row.id)) return false;
  if (
    "deletedAt" in where &&
    where.deletedAt === null &&
    row.deletedAt !== null
  )
    return false;
  if (
    "suspendedAt" in where &&
    where.suspendedAt === null &&
    row.suspendedAt !== null
  )
    return false;
  const login = where.accountLogin as
    { equals: string; mode?: string } | undefined;
  if (login) {
    const insensitive = login.mode === "insensitive";
    const a = insensitive ? row.accountLogin.toLowerCase() : row.accountLogin;
    const b = insensitive ? login.equals.toLowerCase() : login.equals;
    if (a !== b) return false;
  }
  return true;
}

const calls: Where[] = [];
const client: DataClient = {
  installation: {
    findMany: async ({ where }) => {
      calls.push(where);
      return installations.filter((r) => matchesInstallation(r, where));
    },
    findFirst: async ({ where }) => {
      calls.push(where);
      return installations.find((r) => matchesInstallation(r, where)) ?? null;
    },
  },
  repository: {
    findMany: async ({ where }) => {
      calls.push(where);
      return repositories.filter(
        (r) =>
          r.installationId === where.installationId &&
          (where.removedAt !== null || r.removedAt === null),
      );
    },
  },
};

const scope = (...ids: bigint[]): TenantScope => ({
  userId: "user-1",
  role: "VIEWER",
  installationIds: ids,
});

describe("tenant scoping", () => {
  it("an admin scope with both installations sees the personal account and the organisation", async () => {
    const rows = await listInstallations(scope(A, B), client);
    expect(rows.map((r) => r.accountLogin).sort()).toEqual([
      "example-org",
      "example-user",
    ]);
  });

  it("a scope with one installation hides the other", async () => {
    const rows = await listInstallations(scope(A), client);
    expect(rows.map((r) => r.accountLogin)).toEqual(["example-user"]);
  });

  it("an empty scope sees nothing and does not query", async () => {
    calls.length = 0;
    expect(await listInstallations(scope(), client)).toEqual([]);
    expect(
      await findInstallationByAccount(scope(), "example-user", client),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("resolves a visible [account] slug, case-insensitively", async () => {
    expect(
      (await findInstallationByAccount(scope(A, B), "Example-Org", client))?.id,
    ).toBe(B);
  });

  it("a foreign [account] slug resolves to null (rendered as 404)", async () => {
    expect(
      await findInstallationByAccount(scope(A), "example-org", client),
    ).toBeNull();
  });

  it("an unknown slug resolves to null", async () => {
    expect(
      await findInstallationByAccount(scope(A, B), "not-installed", client),
    ).toBeNull();
  });

  it("an uninstalled installation stays hidden even if its id is in scope", async () => {
    expect(
      await findInstallationByAccount(
        scope(A, B, GONE),
        "example-gone",
        client,
      ),
    ).toBeNull();
    const rows = await listInstallations(scope(A, B, GONE), client);
    expect(rows.map((r) => r.id)).not.toContain(GONE);
  });

  it("every installation query is restricted to the scope's ids", async () => {
    calls.length = 0;
    await listInstallations(scope(A), client);
    await findInstallationByAccount(scope(A), "example-user", client);
    for (const where of calls) expect(where.id).toEqual({ in: [A] });
  });

  it("lists repositories of a visible installation without removed ones", async () => {
    const rows = await listRepositories(scope(A, B), B, client);
    expect(rows.map((r) => r.fullName)).toEqual(["example-org/repo-b"]);
  });

  it("repositories of a foreign installation throw NotFoundError without a query", async () => {
    calls.length = 0;
    await expect(listRepositories(scope(A), B, client)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(calls).toHaveLength(0);
  });
});
