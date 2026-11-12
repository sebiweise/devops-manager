import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The token broker (design §3.4, §12 "Token broker"): every act.* purpose
 * requests exactly its permission set and the target repository ids, and
 * mutation tokens are never cached.
 */

const calls = vi.hoisted(() => {
  process.env.GITHUB_APP_ID = "1";
  process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN PLACEHOLDER-----";
  return [] as Array<{ route: string; params: Record<string, unknown> }>;
});

vi.mock("@octokit/app", () => ({
  App: class {
    octokit = {
      request: async (route: string, params: Record<string, unknown>) => {
        calls.push({ route, params });
        return {
          data: {
            token: `token-${calls.length}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        };
      },
    };
  },
}));

const { installationOctokit, forgetInstallationTokens } = await import("./app");

const granted = {
  metadata: "read",
  actions: "write",
  contents: "write",
  pull_requests: "write",
  workflows: "write",
  checks: "read",
  statuses: "read",
  actions_variables: "write",
  organization_actions_variables: "write",
  vulnerability_alerts: "read",
};

describe("installationOctokit", () => {
  beforeEach(() => {
    calls.length = 0;
    forgetInstallationTokens(7);
  });

  it("narrows act.runs to actions: write and the run's repository", async () => {
    await installationOctokit(7, "act.runs", granted, [11n]);
    expect(calls).toEqual([
      {
        route: "POST /app/installations/{installation_id}/access_tokens",
        params: {
          installation_id: 7,
          permissions: { actions: "write" },
          repository_ids: [11],
        },
      },
    ]);
  });

  it("asks for workflows: write only with the workflows merge purpose", async () => {
    await installationOctokit(7, "act.merge", granted, [11n]);
    await installationOctokit(7, "act.merge.workflows", granted, [11n]);
    expect(calls.map((c) => c.params.permissions)).toEqual([
      { contents: "write", pull_requests: "write" },
      { contents: "write", pull_requests: "write", workflows: "write" },
    ]);
  });

  it("narrows act.variables to the target repos, sorted", async () => {
    await installationOctokit(7, "act.variables", granted, [33n, 11n, 22n]);
    expect(calls[0]!.params).toEqual({
      installation_id: 7,
      permissions: { actions_variables: "write" },
      repository_ids: [11, 22, 33],
    });
  });

  it("mints org variable tokens without repository ids", async () => {
    await installationOctokit(7, "act.org_variables", granted);
    expect(calls[0]!.params).toEqual({
      installation_id: 7,
      permissions: { organization_actions_variables: "write" },
    });
  });

  it("refuses a repo-level mutation token without target repos", async () => {
    await expect(installationOctokit(7, "act.runs", granted)).rejects.toThrow(
      /target repository ids/,
    );
    expect(calls).toHaveLength(0);
  });

  it("never caches mutation tokens, but caches read tokens", async () => {
    await installationOctokit(7, "act.runs", granted, [11n]);
    await installationOctokit(7, "act.runs", granted, [11n]);
    await installationOctokit(7, "read.pulls", granted, [11n]);
    await installationOctokit(7, "read.pulls", granted, [11n]);
    expect(calls).toHaveLength(3);
  });

  it("does not mint a token when the permission is not granted", async () => {
    await expect(
      installationOctokit(
        7,
        "act.merge.workflows",
        { ...granted, workflows: undefined },
        [11n],
      ),
    ).rejects.toThrow(/workflows:write/);
    expect(calls).toHaveLength(0);
  });
});
