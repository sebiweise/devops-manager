import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createVercelClient,
  mapEvents,
  mapProject,
  type Fetch,
} from "./client";
import {
  createVercelWriteClient,
  OUTCOME_UNKNOWN,
  vercelWriteErrorInfo,
} from "./write";

/**
 * The M6 write client (design addendum §6, §8.2): exactly four mutations
 * with pinned methods and paths, the audit id in `meta`, team-bound, and
 * ambiguous outcomes for requests that failed after being sent. Plus the
 * new reads: the project's last alias request and the build log events.
 */

const TOKEN = "vcp_testwritetoken000000000000abcd";
const TEAM = "team_test1";
const AUDIT = "0b6f7a52-8f61-4c3e-9a1d-2f3c4b5a6d7e";

type Call = { url: URL; init: RequestInit };

function recorder(respond: (url: URL) => Response) {
  const calls: Call[] = [];
  const fn: Fetch = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    return respond(url);
  };
  return { fn, calls };
}

describe("vercel write client", () => {
  it("sends exactly the four documented mutations with the team", async () => {
    const r = recorder((url) =>
      url.pathname === "/v13/deployments" || url.pathname.endsWith("/cancel")
        ? new Response(
            JSON.stringify({
              id: "dpl_testNEW1",
              projectId: "prj_test1",
              createdAt: 1_700_000_000_000,
              readyState: url.pathname.endsWith("/cancel")
                ? "CANCELED"
                : "QUEUED",
              target: "production",
              meta: { devopsManagerAudit: AUDIT },
            }),
            { status: 200, headers: { "x-vercel-id": "fra1::test-2" } },
          )
        : new Response(null, {
            status: 201,
            headers: { "x-vercel-id": "fra1::test-3" },
          }),
    );
    const api = createVercelWriteClient({
      token: TOKEN,
      teamId: TEAM,
      fetch: r.fn,
    });
    const re = await api.redeploy({
      deploymentId: "dpl_testOLD1",
      projectName: "project-a",
      target: "production",
      withLatestCommit: true,
      auditId: AUDIT,
    });
    expect(re.deployment).toMatchObject({
      id: "dpl_testNEW1",
      state: "QUEUED",
      auditRef: AUDIT,
    });
    expect(re.requestId).toBe("fra1::test-2");
    await api.cancel("dpl_testNEW1");
    expect(await api.promote("prj_test1", "dpl_testOLD1")).toEqual({
      status: 201,
      requestId: "fra1::test-3",
    });
    await api.rollback("prj_test1", "dpl_testOLD1");

    expect(
      r.calls.map(
        (c) => `${c.init.method} ${c.url.pathname}?${c.url.searchParams}`,
      ),
    ).toEqual([
      `POST /v13/deployments?forceNew=1&teamId=${TEAM}`,
      `PATCH /v12/deployments/dpl_testNEW1/cancel?teamId=${TEAM}`,
      `POST /v10/projects/prj_test1/promote/dpl_testOLD1?teamId=${TEAM}`,
      `POST /v1/projects/prj_test1/rollback/dpl_testOLD1?teamId=${TEAM}`,
    ]);
    expect(JSON.parse(String(r.calls[0]!.init.body))).toEqual({
      name: "project-a",
      deploymentId: "dpl_testOLD1",
      target: "production",
      withLatestCommit: true,
      meta: { devopsManagerAudit: AUDIT },
    });
    for (const c of r.calls) {
      expect(c.url.origin).toBe("https://api.vercel.com");
      expect((c.init.headers as Record<string, string>).authorization).toBe(
        `Bearer ${TOKEN}`,
      );
    }
  });

  it("redeploys a preview without a target and refuses odd ids", async () => {
    const r = recorder(
      () =>
        new Response(
          JSON.stringify({
            id: "dpl_testNEW2",
            projectId: "prj_test1",
            createdAt: 1,
          }),
        ),
    );
    const api = createVercelWriteClient({
      token: TOKEN,
      teamId: TEAM,
      fetch: r.fn,
    });
    await api.redeploy({
      deploymentId: "dpl_testOLD2",
      projectName: "project-a",
      target: null,
      withLatestCommit: false,
      auditId: AUDIT,
    });
    const body = JSON.parse(String(r.calls[0]!.init.body));
    expect(body).not.toHaveProperty("target");
    expect(body).not.toHaveProperty("withLatestCommit");
    await expect(api.promote("prj_test1", "../teams")).rejects.toThrow(
      /invalid/,
    );
    await expect(api.cancel("dpl/1")).rejects.toThrow(/invalid/);
    expect(r.calls).toHaveLength(1);
    expect(() => createVercelWriteClient({ token: TOKEN })).toThrow(/team/);
  });

  it("reports a network failure after sending as an unknown outcome", async () => {
    const api = createVercelWriteClient({
      token: TOKEN,
      teamId: TEAM,
      fetch: async () => {
        throw new Error("socket hang up");
      },
    });
    const error = await api
      .promote("prj_test1", "dpl_testOLD1")
      .catch((e: unknown) => e);
    expect(vercelWriteErrorInfo(error)).toEqual({
      status: null,
      message: `${OUTCOME_UNKNOWN}: socket hang up`,
      requestId: null,
    });
    const refused = createVercelWriteClient({
      token: TOKEN,
      teamId: TEAM,
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: { code: "conflict", message: "A rollback is in progress" },
          }),
          { status: 409, headers: { "x-vercel-id": "fra1::test-9" } },
        ),
    });
    const e2 = await refused
      .rollback("prj_test1", "dpl_testOLD1")
      .catch((e: unknown) => e);
    expect(vercelWriteErrorInfo(e2)).toEqual({
      status: 409,
      message: "conflict: A rollback is in progress",
      requestId: "fra1::test-9",
    });
  });

  it("is used only by the action pipeline; the read client never mutates", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
          files.push(p);
      }
    };
    walk(root);
    const users = files
      .filter((f) =>
        readFileSync(f, "utf8").includes("createVercelWriteClient"),
      )
      .map((f) => f.replace(/\\/g, "/").split("/src/")[1])
      .sort();
    expect(users).toEqual(["server/authz/action.ts", "server/vercel/write.ts"]);
    const client = readFileSync(
      new URL("./client.ts", import.meta.url),
      "utf8",
    );
    expect(client).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
  });
});

describe("vercel M6 reads", () => {
  it("reads the last alias request of one project", async () => {
    const p = mapProject({
      id: "prj_test1",
      name: "project-a",
      lastAliasRequest: {
        type: "rollback",
        jobStatus: "succeeded",
        requestedAt: 1_700_000_000_000,
        toDeploymentId: "dpl_testOLD1",
        fromDeploymentId: "dpl_testNEW1",
      },
      targets: { production: { id: "dpl_testOLD1" } },
    });
    expect(p.aliasRequest).toEqual({
      type: "rollback",
      status: "succeeded",
      at: new Date(1_700_000_000_000),
      toDeploymentId: "dpl_testOLD1",
    });
    expect(mapProject({ id: "prj_test2", name: "b" }).aliasRequest).toBeNull();

    const r = recorder(
      () =>
        new Response(JSON.stringify({ id: "prj_test1", name: "project-a" })),
    );
    await createVercelClient({
      token: TOKEN,
      teamId: TEAM,
      fetch: r.fn,
    }).getProject("prj_test1");
    expect(r.calls[0]!.url.pathname).toBe("/v9/projects/prj_test1");
    expect(r.calls[0]!.url.searchParams.get("rollbackInfo")).toBe("true");
  });

  it("keeps the newest build output lines in order, text only", async () => {
    const events = [
      { type: "delimiter", created: 1, payload: { text: "ignored", date: 1 } },
      { type: "stdout", created: 3, payload: { text: "third", date: 3 } },
      { type: "command", created: 2, payload: { text: "pnpm build", date: 2 } },
      null,
      { type: "stderr", created: 4, date: 4, text: "Error: failed" },
      { type: "deployment-state", created: 5, payload: { date: 5 } },
    ];
    expect(
      mapEvents(events).map((l) => [l.type, l.text, l.at?.getTime()]),
    ).toEqual([
      ["command", "pnpm build", 2],
      ["stdout", "third", 3],
      ["stderr", "Error: failed", 4],
    ]);
    const many = Array.from({ length: 300 }, (_, i) => ({
      type: "stdout",
      created: i + 1,
      payload: { text: `line ${i}`, date: i + 1 },
    }));
    const kept = mapEvents(many);
    expect(kept).toHaveLength(200);
    expect(kept[0]!.text).toBe("line 100");

    const r = recorder(() => new Response(JSON.stringify(events)));
    await createVercelClient({
      token: TOKEN,
      teamId: TEAM,
      fetch: r.fn,
    }).getBuildLog("dpl_test1");
    const q = r.calls[0]!.url.searchParams;
    expect(r.calls[0]!.url.pathname).toBe("/v3/deployments/dpl_test1/events");
    expect([q.get("follow"), q.get("direction"), q.get("limit")]).toEqual([
      "0",
      "backward",
      "200",
    ]);
  });
});
