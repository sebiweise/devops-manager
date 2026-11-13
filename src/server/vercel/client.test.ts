import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createVercelClient,
  creatorKindOf,
  firstLine,
  mapDeployment,
  mapProject,
  mapToken,
  MAX_RESPONSE_BYTES,
  retryAtOf,
  vercelDeploymentUrl,
  vercelUrl,
  VercelError,
  VercelTimeout,
  type Fetch,
} from "./client";

type Call = { url: URL; init: RequestInit };

function fakeFetch(
  handler: (url: URL) => {
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
    raw?: string;
  },
) {
  const calls: Call[] = [];
  const fn: Fetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const r = handler(url);
    return new Response(r.raw ?? JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  };
  return { fn, calls };
}

const TOKEN = "vcp_testtoken0000000000000000abcd";

describe("vercel client", () => {
  it("appends teamId to team resources only and sends the bearer token", async () => {
    const f = fakeFetch((url) =>
      url.pathname === "/v2/user"
        ? { body: { user: { id: "u1", defaultTeamId: "team_test1" } } }
        : { body: { projects: [], pagination: { next: null } } },
    );
    const api = createVercelClient({
      token: TOKEN,
      teamId: "team_test1",
      fetch: f.fn,
    });
    await api.getUser();
    await api.listProjects();
    expect(f.calls[0]!.url.searchParams.get("teamId")).toBeNull();
    expect(f.calls[1]!.url.searchParams.get("teamId")).toBe("team_test1");
    expect(f.calls[1]!.url.origin).toBe("https://api.vercel.com");
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("issues only GET requests (M5 is read-only)", async () => {
    const f = fakeFetch((url) => {
      switch (url.pathname) {
        case "/v2/user":
          return { body: { user: { id: "u1" } } };
        case "/v5/user/tokens/current":
          return { body: { token: { id: "t", scopes: [] } } };
        case "/v2/teams":
          return { body: { teams: [] } };
        case "/v7/deployments":
          return { body: { deployments: [], pagination: { next: null } } };
        default:
          return url.pathname.startsWith("/v2/teams/")
            ? { body: { id: "team_test1", slug: "team-a" } }
            : {
                body: { id: "dpl_test1", projectId: "prj_test1", createdAt: 1 },
              };
      }
    });
    const api = createVercelClient({
      token: TOKEN,
      teamId: "team_test1",
      fetch: f.fn,
    });
    await api.getUser();
    await api.getCurrentToken();
    await api.getTeam("team_test1");
    await api.listTeams();
    await api.listProjects().catch(() => undefined);
    await api.listDeployments({});
    await api.getDeployment("dpl_test1");
    expect(f.calls.length).toBeGreaterThanOrEqual(7);
    expect(f.calls.every((c) => c.init.method === "GET")).toBe(true);
    // No mutating method anywhere in the client's source.
    const source = readFileSync(
      new URL("./client.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
  });

  it("refuses a decrypt parameter and foreign origins", () => {
    expect(() =>
      vercelUrl("/v10/projects/p/env", { decrypt: "true" } as never, null),
    ).toThrow(/decrypt/);
    expect(() =>
      vercelUrl("/v10/projects/p/env", { Decrypt: "1" } as never, null),
    ).toThrow(/decrypt/);
    expect(() => vercelUrl("//evil.example.com/x", {}, null)).toThrow();
    expect(vercelUrl("/v2/user", {}, null).origin).toBe(
      "https://api.vercel.com",
    );
  });

  it("follows pagination.next with until and maps deployments", async () => {
    const pages: Record<string, unknown> = {
      first: {
        deployments: [
          {
            uid: "dpl_test2",
            name: "project-a",
            projectId: "prj_test1",
            url: "project-a-abc.vercel.app",
            created: 2000,
            createdAt: 2000,
            buildingAt: 2100,
            ready: 2600,
            readyState: "READY",
            target: "production",
            source: "git",
            meta: {
              githubCommitSha: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
              githubCommitRef: "main",
              githubCommitMessage: "feat: first line\n\nbody with details",
              githubCommitAuthorName: "Example Person",
              githubCommitAuthorLogin: "example-user",
            },
            creator: {
              uid: "u1",
              username: "example-user",
              email: "user@example.com",
            },
          },
        ],
        pagination: { count: 1, next: 1999, prev: null },
      },
      second: {
        deployments: [
          {
            uid: "dpl_test1",
            name: "project-a",
            projectId: "prj_test1",
            url: null,
            createdAt: 1000,
            readyState: "ERROR",
            errorCode: "BUILD_FAILED",
            target: null,
            source: "cli",
          },
        ],
        pagination: { count: 1, next: null, prev: null },
      },
    };
    const f = fakeFetch((url) => ({
      body: url.searchParams.get("until") ? pages.second : pages.first,
    }));
    const api = createVercelClient({
      token: TOKEN,
      teamId: "team_test1",
      fetch: f.fn,
    });
    const first = await api.listDeployments({ since: 500 });
    expect(first.next).toBe(1999);
    const second = await api.listDeployments({ since: 500, until: first.next });
    expect(f.calls[1]!.url.searchParams.get("until")).toBe("1999");
    expect(f.calls[1]!.url.searchParams.get("since")).toBe("500");
    expect(second.next).toBeNull();

    const d = first.deployments[0]!;
    expect(d).toMatchObject({
      id: "dpl_test2",
      projectId: "prj_test1",
      target: "production",
      state: "READY",
      url: "project-a-abc.vercel.app",
      branch: "main",
      commitSha: "abcdef1234567890abcdef1234567890abcdef12",
      commitMessage: "feat: first line",
      creatorKind: "git",
      buildMs: 500,
    });
    // No user names, logins or e-mail addresses survive the boundary.
    const json = JSON.stringify(first);
    expect(json).not.toContain("Example Person");
    expect(json).not.toContain("example-user");
    expect(json).not.toContain("user@example.com");
    expect(second.deployments[0]).toMatchObject({
      target: "preview",
      state: "ERROR",
      errorCode: "BUILD_FAILED",
      creatorKind: "cli",
      url: null,
    });
  });

  it("drops env values and every unlisted project field", async () => {
    const f = fakeFetch(() => ({
      body: {
        projects: [
          {
            id: "prj_test1",
            name: "project-a",
            framework: "nextjs",
            env: [{ key: "SECRET_KEY", value: "plain-secret-value" }],
            link: {
              type: "github",
              org: "example-org",
              repo: "repo-a",
              repoId: 201,
              productionBranch: "main",
              deployHooks: [
                {
                  url: "https://api.vercel.com/v1/integrations/deploy/hook-secret",
                },
              ],
            },
            targets: {
              production: { id: "dpl_test2", alias: ["app.example.com"] },
            },
          },
        ],
        pagination: { next: null },
      },
    }));
    const api = createVercelClient({
      token: TOKEN,
      teamId: "team_test1",
      fetch: f.fn,
    });
    const res = await api.listProjects();
    expect(res.projects[0]).toEqual({
      id: "prj_test1",
      name: "project-a",
      framework: "nextjs",
      linkType: "github",
      linkRepoId: 201n,
      linkRepo: "example-org/repo-a",
      productionBranch: "main",
      paused: false,
      liveProductionId: "dpl_test2",
    });
    const json = JSON.stringify(res, (_k, v) =>
      typeof v === "bigint" ? String(v) : v,
    );
    expect(json).not.toContain("plain-secret-value");
    expect(json).not.toContain("SECRET_KEY");
    expect(json).not.toContain("hook-secret");
  });

  it("maps 401 and token 403 to revoked, other 403 not", async () => {
    const status = { code: 401, body: {} as unknown };
    const f = fakeFetch(() => ({
      status: status.code,
      body: status.body,
      headers: { "x-vercel-id": "fra1::req-1" },
    }));
    const api = createVercelClient({ token: TOKEN, fetch: f.fn });
    const err = await api.getUser().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VercelError);
    expect((err as VercelError).revoked).toBe(true);
    expect((err as VercelError).requestId).toBe("fra1::req-1");

    status.code = 403;
    status.body = {
      error: {
        code: "forbidden",
        message: "Not authorized",
        invalidToken: true,
      },
    };
    expect(
      ((await api.getUser().catch((e: unknown) => e)) as VercelError).revoked,
    ).toBe(true);

    status.body = { error: { code: "forbidden", message: "Not authorized" } };
    const other = (await api.getUser().catch((e: unknown) => e)) as VercelError;
    expect(other.revoked).toBe(false);
    expect(other.code).toBe("forbidden");
  });

  it("reads the retry time of a 429 from the body, then retry-after, then +60 s", async () => {
    const now = 1_700_000_000_000;
    expect(
      retryAtOf(
        { error: { limit: { resetMs: now + 5000 } } },
        null,
        now,
      ).getTime(),
    ).toBe(now + 5000);
    expect(
      retryAtOf(
        { error: { limit: { reset: now / 1000 + 7 } } },
        null,
        now,
      ).getTime(),
    ).toBe(now + 7000);
    expect(retryAtOf({}, "30", now).getTime()).toBe(now + 30_000);
    expect(retryAtOf({}, null, now).getTime()).toBe(now + 60_000);

    const f = fakeFetch(() => ({
      status: 429,
      body: {
        error: {
          code: "rate_limited",
          message: "slow down",
          limit: { resetMs: now + 9000 },
        },
      },
    }));
    const api = createVercelClient({
      token: TOKEN,
      fetch: f.fn,
      now: () => now,
    });
    const err = (await api.getUser().catch((e: unknown) => e)) as VercelError;
    expect(err.rateLimited).toBe(true);
    expect(err.retryAt?.getTime()).toBe(now + 9000);
  });

  it("times out a hung request", async () => {
    const hung: Fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    const api = createVercelClient({
      token: TOKEN,
      fetch: hung,
      timeoutMs: 20,
    });
    await expect(api.getUser()).rejects.toBeInstanceOf(VercelTimeout);
  });

  it("refuses responses over 5 MB and unexpected shapes", async () => {
    const big = fakeFetch(() => ({ raw: "x".repeat(MAX_RESPONSE_BYTES + 10) }));
    const api = createVercelClient({ token: TOKEN, fetch: big.fn });
    const err = (await api.getUser().catch((e: unknown) => e)) as VercelError;
    expect(err.code).toBe("too_large");
    const odd = fakeFetch(() => ({ body: { nope: true } }));
    const api2 = createVercelClient({ token: TOKEN, fetch: odd.fn });
    expect(
      ((await api2.getUser().catch((e: unknown) => e)) as VercelError).code,
    ).toBe("unexpected_response");
  });

  it("never puts the token into an error", async () => {
    const f = fakeFetch(() => ({
      status: 400,
      body: { error: { code: "bad_request", message: "bad" } },
    }));
    const api = createVercelClient({ token: TOKEN, fetch: f.fn });
    const err = (await api.getUser().catch((e: unknown) => e)) as VercelError;
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain(
      TOKEN,
    );
  });
});

describe("vercel mappers", () => {
  it("maps the creator kind from the deployment source", () => {
    expect(creatorKindOf("git")).toBe("git");
    expect(creatorKindOf("cli")).toBe("cli");
    expect(creatorKindOf("redeploy")).toBe("redeploy");
    expect(creatorKindOf("git-deploy-hook")).toBe("api");
    expect(creatorKindOf("something-new")).toBeNull();
    expect(creatorKindOf(undefined)).toBeNull();
  });

  it("falls back to gitSource when meta has no commit", () => {
    const d = mapDeployment({
      id: "dpl_test3",
      projectId: "prj_test1",
      createdAt: 10,
      readyState: "BUILDING",
      gitSource: {
        sha: "0123456789abcdef0123456789abcdef01234567",
        ref: "feature/x",
      },
    });
    expect(d).toMatchObject({
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      branch: "feature/x",
      state: "BUILDING",
      target: "preview",
      buildMs: null,
    });
  });

  it("drops invalid hosts and SHAs and unknown states", () => {
    const d = mapDeployment({
      uid: "dpl_test4",
      projectId: "prj_test1",
      createdAt: 10,
      url: "https://evil.example.com/path?x=1",
      readyState: "SOMETHING",
      meta: { githubCommitSha: "not-a-sha" },
    });
    expect(d?.url).toBe("evil.example.com");
    expect(d?.commitSha).toBeNull();
    expect(d?.state).toBe("UNKNOWN");
    expect(mapDeployment({ projectId: "p", createdAt: 1 })).toBeNull();
  });

  it("keeps the first line of a commit message, at most 200 characters", () => {
    expect(firstLine("a\nb")).toBe("a");
    expect(firstLine("x".repeat(300))).toHaveLength(200);
    expect(firstLine("  ")).toBeNull();
  });

  it("maps token scopes and CLI-linked projects", () => {
    expect(
      mapToken({
        token: {
          id: "t",
          expiresAt: 5,
          scopes: [{ type: "team", teamId: "team_a" }],
        },
      }),
    ).toEqual({ expiresAt: new Date(5), teamIds: ["team_a"], full: false });
    expect(
      mapToken({ token: { id: "t", scopes: [{ type: "user" }] } }).full,
    ).toBe(true);
    expect(mapProject({ id: "prj_test2", name: "project-b" })).toMatchObject({
      linkType: null,
      linkRepoId: null,
      linkRepo: null,
    });
    // A non-GitHub link never yields a GitHub repository id.
    expect(
      mapProject({
        id: "prj_test3",
        name: "c",
        link: { type: "gitlab", repoId: 5 },
      }).linkRepoId,
    ).toBeNull();
  });

  it("builds deployment links from stored ids", () => {
    expect(vercelDeploymentUrl("team-a", "project-a", "dpl_AbC123")).toBe(
      "https://vercel.com/team-a/project-a/AbC123",
    );
  });
});
