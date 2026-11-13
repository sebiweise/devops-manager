import { describe, expect, it } from "vitest";
import {
  AzureError,
  authHeader,
  azureUrl,
  createAzureClient,
  createAzureTransport,
  normalizeOrg,
  rateInfoOf,
  stopUntil,
  type Fetch,
} from "./client";
import { z } from "zod";

const PAT = "test-pat-not-real-0001"; // gitleaks:allow (test placeholder)

function fake(respond: (url: URL, init: RequestInit) => Response): {
  fetch: Fetch;
  calls: Array<{ url: URL; init: RequestInit }>;
} {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, init });
      return respond(url, init);
    },
  };
}

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("organisation and URLs", () => {
  it("normalises names, dev.azure.com and legacy visualstudio.com forms", () => {
    expect(normalizeOrg("contoso-ci")).toBe("contoso-ci");
    expect(normalizeOrg("https://dev.azure.com/contoso-ci/project-a")).toBe(
      "contoso-ci",
    );
    expect(normalizeOrg("contoso-ci.visualstudio.com")).toBe("contoso-ci");
    expect(
      normalizeOrg("https://fabrikam.visualstudio.com/DefaultCollection"),
    ).toBe("fabrikam");
  });

  it("refuses anything that could leave the pinned host", () => {
    for (const bad of [
      "",
      "-leading",
      "a".repeat(51),
      "evil.example.com",
      "https://evil.example.com/contoso",
      "contoso/../x",
      "contoso ci",
      "conto%2Fso",
    ])
      expect(normalizeOrg(bad), bad).toBeNull();
    expect(() => azureUrl("contoso-ci", "//evil.example.com/x")).toThrow();
    expect(() => azureUrl("contoso-ci", "/../x")).toThrow();
    expect(() => azureUrl("bad.org", "/_apis/projects")).toThrow();
    const u = azureUrl("contoso-ci", "/_apis/projects", { $top: 5 });
    expect(u.origin).toBe("https://dev.azure.com");
    expect(u.pathname).toBe("/contoso-ci/_apis/projects");
    expect(u.searchParams.get("api-version")).toBe("7.1");
  });

  it("sends a PAT as Basic with an empty user and a token as Bearer", () => {
    expect(authHeader({ kind: "basic", pat: PAT })).toBe(
      `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`,
    );
    expect(authHeader({ kind: "bearer", token: "abc" })).toBe("Bearer abc");
  });
});

describe("rate limits", () => {
  it("reads the headers and stops on Retry-After or low headroom", () => {
    const now = Date.UTC(2026, 10, 13, 10);
    const h = new Headers({
      "x-ratelimit-limit": "200",
      "x-ratelimit-remaining": "30",
      "x-ratelimit-reset": String(now / 1000 + 120),
    });
    const info = rateInfoOf(h, now);
    expect(info).toMatchObject({ limit: 200, remaining: 30 });
    expect(stopUntil(info, now)?.getTime()).toBe(now + 120_000);
    expect(
      stopUntil(
        rateInfoOf(
          new Headers({
            "x-ratelimit-limit": "200",
            "x-ratelimit-remaining": "41",
          }),
          now,
        ),
        now,
      ),
    ).toBeNull();
    expect(
      stopUntil(
        rateInfoOf(new Headers({ "retry-after": "7" }), now),
        now,
      )?.getTime(),
    ).toBe(now + 7000);
  });

  it("ends the pass after a 200 that carries Retry-After", async () => {
    const f = fake(() =>
      json({ count: 0, value: [] }, 200, { "retry-after": "30" }),
    );
    const api = createAzureClient({
      org: "contoso-ci",
      auth: { kind: "basic", pat: PAT },
      fetch: f.fetch,
    });
    await expect(api.listProjects()).resolves.toMatchObject({ projects: [] });
    await expect(api.listProjects()).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(f.calls).toHaveLength(1);
  });

  it("maps 429 and TF400733 to rate_limited with a retry time", async () => {
    for (const res of [
      () => json({ message: "slow down" }, 429, { "retry-after": "60" }),
      () => json({ message: "TF400733: The request has been canceled" }, 503),
    ]) {
      const api = createAzureClient({
        org: "contoso-ci",
        auth: { kind: "basic", pat: PAT },
        fetch: fake(res).fetch,
      });
      const err = await api.listPools().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AzureError);
      expect((err as AzureError).rateLimited).toBe(true);
      expect((err as AzureError).retryAt).toBeInstanceOf(Date);
    }
  });

  it("caps the requests of a pass", async () => {
    const t = createAzureTransport({
      org: "contoso-ci",
      auth: { kind: "basic", pat: PAT },
      fetch: fake(() => json({})).fetch,
      maxRequests: 2,
    });
    const req = {
      method: "GET" as const,
      path: "/_apis/x",
      schema: z.unknown(),
    };
    await t.request(req);
    await t.request(req);
    await expect(t.request(req)).rejects.toMatchObject({ code: "request_cap" });
  });
});

describe("credential failures", () => {
  it("treats 401, 203, redirects and HTML pages as invalid_token", async () => {
    const answers = [
      () => json({ message: "TF400813" }, 401),
      () =>
        new Response("<html>Sign in</html>", {
          status: 203,
          headers: { "content-type": "text/html" },
        }),
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://login.example.com" },
        }),
      () =>
        new Response("<html>Sign in</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ];
    for (const a of answers) {
      const api = createAzureClient({
        org: "contoso-ci",
        auth: { kind: "basic", pat: PAT },
        fetch: fake(a).fetch,
      });
      const err = (await api
        .listProjects()
        .catch((e: unknown) => e)) as AzureError;
      expect(err.code).toBe("invalid_token");
      expect(err.revoked).toBe(true);
    }
  });

  it("never follows redirects and asks for no sign-in redirect", async () => {
    const f = fake(() => json({ count: 0, value: [] }));
    await createAzureClient({
      org: "contoso-ci",
      auth: { kind: "basic", pat: PAT },
      fetch: f.fetch,
    }).listPools();
    expect(f.calls[0]!.init.redirect).toBe("manual");
    expect(
      (f.calls[0]!.init.headers as Record<string, string>)[
        "x-tfs-fedauthredirect"
      ],
    ).toBe("Suppress");
  });
});

describe("allowlist schemas", () => {
  it("drops identities, e-mail addresses and links from builds", async () => {
    const f = fake(() =>
      json(
        {
          count: 1,
          value: [
            {
              id: 7,
              buildNumber: "1",
              status: "completed",
              result: "succeeded",
              reason: "manual",
              queueTime: "2026-11-13T10:00:00Z",
              definition: { id: 3, name: "ci" },
              project: { id: "00000000-0000-4000-8000-000000000011" },
              requestedFor: {
                displayName: "Example Person",
                uniqueName: "person@example.com",
              },
              lastChangedBy: { uniqueName: "person@example.com" },
              _links: { web: { href: "https://evil.example.com" } },
              triggerInfo: {
                "pr.number": "4",
                "pr.sourceSha": "a".repeat(40),
                "ci.message": "by person@example.com",
              },
            },
          ],
        },
        200,
        { "x-ms-continuationtoken": "next-1" },
      ),
    );
    const r = await createAzureClient({
      org: "contoso-ci",
      auth: { kind: "basic", pat: PAT },
      fetch: f.fetch,
    }).listBuilds("00000000-0000-4000-8000-000000000011", { top: 1 });
    expect(r.continuation).toBe("next-1");
    const text = JSON.stringify(r);
    expect(text).not.toMatch(
      /Example Person|person@example\.com|evil\.example\.com/,
    );
    expect(r.builds[0]!.triggerInfo).toEqual({
      prNumber: "4",
      prSourceSha: "a".repeat(40),
      prSourceBranch: null,
    });
  });

  it("drops the pool owner and creator", async () => {
    const f = fake(() =>
      json({
        count: 1,
        value: [
          {
            id: 9,
            name: "Azure Pipelines",
            isHosted: true,
            poolType: "automation",
            owner: { uniqueName: "person@example.com" },
            createdBy: { displayName: "Example Person" },
          },
        ],
      }),
    );
    const pools = await createAzureClient({
      org: "contoso-ci",
      auth: { kind: "basic", pat: PAT },
      fetch: f.fetch,
    }).listPools();
    expect(JSON.stringify(pools)).not.toMatch(/person/i);
  });

  it("returns null for resourceusage that is missing or changed shape", async () => {
    for (const res of [
      () => json({ message: "x" }, 404),
      () => json({ resourceLimit: "bad" }),
    ]) {
      const api = createAzureClient({
        org: "contoso-ci",
        auth: { kind: "basic", pat: PAT },
        fetch: fake(res).fetch,
      });
      await expect(api.getResourceUsage()).resolves.toBeNull();
    }
  });

  it("caps the response size", async () => {
    const big = "x".repeat(6 * 1024 * 1024);
    const api = createAzureClient({
      org: "contoso-ci",
      auth: { kind: "basic", pat: PAT },
      fetch: fake(() => new Response(big)).fetch,
    });
    await expect(api.listPools()).rejects.toMatchObject({ code: "too_large" });
  });
});
