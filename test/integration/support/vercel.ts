import type { Fetch } from "@/server/vercel/client";

/**
 * An in-memory Vercel REST API for the integration tests (design addendum
 * §12). It enforces the token-to-team binding, answers 401/429 on demand,
 * returns env values in project lists (to prove the client drops them),
 * fails on `decrypt=true`, paginates like Vercel (newest first,
 * `pagination.next` = the oldest `createdAt` of the page) and records every
 * call. All ids and names are placeholders.
 *
 * Writes (M6) answer only when `writes` is on: redeploy (echoes `meta`,
 * creator source "redeploy"), cancel (queued or building only), promote and
 * rollback (move the serving deployment, record the alias request; on
 * Hobby only the previous production deployment may be rolled back to).
 * `dropAfterSend` applies a write and then fails at the network level, so
 * the outcome is unknown to the caller.
 */

export type FakeToken = {
  /** Team ids a team-scoped token is bound to; empty for full-account tokens. */
  teams: string[];
  /** Full-account token: reaches every team the user is a member of. */
  full?: boolean;
  expiresAt?: number;
  revoked?: boolean;
};

export type FakeTeam = { id: string; slug: string; name: string; plan: string };

export type FakeProject = {
  id: string;
  teamId: string;
  name: string;
  repoId?: number;
  repo?: string;
  liveProductionId?: string;
  alias?: {
    type: "promote" | "rollback";
    jobStatus: string;
    requestedAt: number;
    toDeploymentId: string;
    fromDeploymentId: string | null;
  };
};

export type FakeDeployment = {
  uid: string;
  teamId: string;
  projectId: string;
  name: string;
  createdAt: number;
  readyState: string;
  target: "production" | null;
  sha?: string;
  ref?: string;
  message?: string;
  buildingAt?: number;
  ready?: number;
  source?: string;
  meta?: Record<string, string>;
};

export type FakeCall = {
  method: string;
  path: string;
  query: Record<string, string>;
  token: string;
};

/** A value that must never reach the database or a page. */
export const ENV_SECRET_VALUE = "env-value-that-must-not-be-stored-0001";

export class FakeVercel {
  readonly tokens = new Map<string, FakeToken>();
  readonly teams = new Map<string, FakeTeam>();
  readonly projects: FakeProject[] = [];
  readonly deployments: FakeDeployment[] = [];
  readonly calls: FakeCall[] = [];
  /** Members of the (single) user behind full-account tokens. */
  memberOf: string[] = [];
  /** The next responses for these paths (prefix match), consumed in order. */
  private overrides: Array<{
    path: string;
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  }> = [];
  decryptRequested = false;
  /** M6: answer POST/PATCH writes (off: 405 like the read-only M5 fake). */
  writes = false;
  /** Paths (prefix) whose next write is applied, then fails at the network level. */
  dropAfterSend: string[] = [];
  /** False: a redeploy does not keep the meta it was sent (fallback linking). */
  echoMeta = true;
  /** Build log events per deployment id. */
  readonly logs = new Map<string, unknown[]>();
  private created = 0;
  /** Called before each response (tests advance a clock here). */
  onRequest?: (call: FakeCall) => void;

  addTeam(team: FakeTeam) {
    this.teams.set(team.id, team);
    if (!this.memberOf.includes(team.id)) this.memberOf.push(team.id);
  }

  failNext(
    path: string,
    status: number,
    body: unknown = {},
    headers?: Record<string, string>,
  ) {
    this.overrides.push({ path, status, body, headers });
  }

  addDeployment(d: FakeDeployment) {
    this.deployments.push(d);
  }

  callsTo(prefix: string) {
    return this.calls.filter((c) => c.path.startsWith(prefix));
  }

  fetch(): Fetch {
    return async (input, init) => {
      const url = new URL(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      const token = (headers.authorization ?? "").replace(/^Bearer /, "");
      const call: FakeCall = {
        method: init.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        token,
      };
      this.calls.push(call);
      this.onRequest?.(call);
      const json = (
        status: number,
        body: unknown,
        extra: Record<string, string> = {},
      ) =>
        new Response(JSON.stringify(body), {
          status,
          headers: {
            "content-type": "application/json",
            "x-vercel-id": `fake::${this.calls.length}`,
            ...extra,
          },
        });
      if (url.origin !== "https://api.vercel.com") return json(404, {});
      if (call.method !== "GET" && !this.writes)
        return json(405, {
          error: { code: "method_unknown", message: "GET only in M5" },
        });
      if (url.searchParams.has("decrypt")) {
        this.decryptRequested = true;
        return json(400, {
          error: {
            code: "bad_request",
            message: "decrypt refused by the fake",
          },
        });
      }
      const o = this.overrides.findIndex((x) =>
        url.pathname.startsWith(x.path),
      );
      if (o >= 0) {
        const [hit] = this.overrides.splice(o, 1);
        return json(hit!.status, hit!.body, hit!.headers);
      }
      const t = this.tokens.get(token);
      if (!t || t.revoked)
        return json(401, {
          error: {
            code: "forbidden",
            message: "Not authorized",
            invalidToken: true,
          },
        });
      const reachable = (teamId: string) =>
        t.full ? this.memberOf.includes(teamId) : t.teams.includes(teamId);
      const teamId = url.searchParams.get("teamId");
      if (teamId && !reachable(teamId))
        return json(403, {
          error: {
            code: "forbidden",
            message: "Not authorized to access the team",
          },
        });

      const p = url.pathname;
      if (p === "/v2/user")
        return json(200, {
          user: {
            id: "user_test1",
            username: "example-user",
            email: "user@example.com",
            name: "Example Person",
            defaultTeamId: this.memberOf[0] ?? null,
          },
        });
      if (p === "/v5/user/tokens/current")
        return json(200, {
          token: {
            id: "tok_test1",
            name: "example token",
            type: "oauth2-token",
            expiresAt: t.expiresAt,
            scopes: t.full
              ? [{ type: "user", origin: "manual" }]
              : t.teams.map((id) => ({
                  type: "team",
                  teamId: id,
                  origin: "manual",
                })),
          },
        });
      if (p === "/v2/teams")
        return json(200, {
          teams: [...this.teams.values()]
            .filter((x) => reachable(x.id))
            .map((x) => ({
              id: x.id,
              slug: x.slug,
              name: x.name,
              billing: { plan: x.plan },
              avatar: "abc",
            })),
          pagination: { count: 1, next: null, prev: null },
        });
      const team = p.match(/^\/v2\/teams\/([^/]+)$/);
      if (team) {
        const x = this.teams.get(decodeURIComponent(team[1]!));
        if (!x || !reachable(x.id))
          return json(404, {
            error: { code: "not_found", message: "Team was not found" },
          });
        return json(200, {
          id: x.id,
          slug: x.slug,
          name: x.name,
          billing: { plan: x.plan },
          inviteCode: "secret-invite",
        });
      }
      if (!teamId)
        return json(400, {
          error: { code: "bad_request", message: "teamId missing in the fake" },
        });
      if (p === "/v10/projects") {
        const all = this.projects.filter((x) => x.teamId === teamId);
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const from = Number(url.searchParams.get("from") ?? 0);
        const page = all.slice(from, from + limit);
        return json(200, {
          projects: page.map((x) => ({
            id: x.id,
            name: x.name,
            accountId: teamId,
            framework: "nextjs",
            env: [
              {
                key: "DATABASE_PASSWORD",
                value: ENV_SECRET_VALUE,
                type: "plain",
              },
            ],
            link: x.repoId
              ? {
                  type: "github",
                  org: x.repo?.split("/")[0],
                  repo: x.repo?.split("/")[1],
                  repoId: x.repoId,
                  productionBranch: "main",
                }
              : undefined,
            targets: x.liveProductionId
              ? { production: { id: x.liveProductionId } }
              : undefined,
          })),
          pagination: {
            count: page.length,
            next: from + limit < all.length ? String(from + limit) : null,
          },
        });
      }
      if (p === "/v7/deployments") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const until = url.searchParams.get("until");
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const projectId = url.searchParams.get("projectId");
        const all = this.deployments
          .filter(
            (d) =>
              d.teamId === teamId &&
              d.createdAt > since &&
              (until == null || d.createdAt < Number(until)) &&
              (!projectId || d.projectId === projectId),
          )
          .sort((a, b) => b.createdAt - a.createdAt);
        const page = all.slice(0, limit);
        return json(200, {
          deployments: page.map((d) => this.render(d)),
          pagination: {
            count: page.length,
            next: all.length > limit ? page[page.length - 1]!.createdAt : null,
            prev: null,
          },
        });
      }
      if (call.method !== "GET") {
        const body =
          typeof init.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {};
        const res = this.write(call.method, p, teamId, body);
        const drop = this.dropAfterSend.findIndex((x) => p.startsWith(x));
        if (drop >= 0) {
          this.dropAfterSend.splice(drop, 1);
          throw new TypeError("fetch failed: socket hang up");
        }
        return res.body === null
          ? new Response(null, {
              status: res.status,
              headers: { "x-vercel-id": `fake::${this.calls.length}` },
            })
          : json(res.status, res.body);
      }
      const proj = p.match(/^\/v9\/projects\/([^/]+)$/);
      if (proj) {
        const x = this.projects.find(
          (q) => q.id === proj[1] && q.teamId === teamId,
        );
        if (!x)
          return json(404, {
            error: { code: "not_found", message: "Project not found" },
          });
        return json(200, {
          id: x.id,
          name: x.name,
          framework: "nextjs",
          env: [{ key: "SECRET", value: ENV_SECRET_VALUE, type: "plain" }],
          targets: x.liveProductionId
            ? { production: { id: x.liveProductionId } }
            : undefined,
          lastAliasRequest:
            url.searchParams.get("rollbackInfo") === "true"
              ? (x.alias ?? null)
              : null,
        });
      }
      const events = p.match(/^\/v3\/deployments\/([^/]+)\/events$/);
      if (events) {
        const d = this.deployments.find(
          (x) => x.uid === events[1] && x.teamId === teamId,
        );
        if (!d)
          return json(404, {
            error: { code: "not_found", message: "Deployment not found" },
          });
        return json(200, this.logs.get(d.uid) ?? []);
      }
      const one = p.match(/^\/v13\/deployments\/([^/]+)$/);
      if (one) {
        const d = this.deployments.find(
          (x) => x.uid === one[1] && x.teamId === teamId,
        );
        if (!d)
          return json(404, {
            error: { code: "not_found", message: "Deployment not found" },
          });
        const r = this.render(d);
        return json(200, { ...r, id: r.uid, uid: undefined });
      }
      return json(404, {
        error: { code: "not_found", message: `no route ${p}` },
      });
    };
  }

  private write(
    method: string,
    p: string,
    teamId: string,
    body: Record<string, unknown>,
  ): { status: number; body: unknown } {
    const err = (status: number, code: string, message: string) => ({
      status,
      body: { error: { code, message } },
    });
    const now = Date.now();
    if (method === "POST" && p === "/v13/deployments") {
      const from = this.deployments.find(
        (d) => d.uid === body.deploymentId && d.teamId === teamId,
      );
      if (!from) return err(404, "not_found", "Deployment not found");
      this.created++;
      const d: FakeDeployment = {
        uid: `dpl_testR${this.created}`,
        teamId,
        projectId: from.projectId,
        name: String(body.name ?? from.name),
        createdAt: now,
        readyState: "QUEUED",
        target: body.target === "production" ? "production" : null,
        sha: from.sha,
        ref: from.ref,
        source: "redeploy",
        meta: this.echoMeta
          ? ((body.meta ?? {}) as Record<string, string>)
          : {},
      };
      this.deployments.push(d);
      const r = this.render(d);
      return { status: 200, body: { ...r, id: r.uid, uid: undefined } };
    }
    const cancel = p.match(/^\/v12\/deployments\/([^/]+)\/cancel$/);
    if (method === "PATCH" && cancel) {
      const d = this.deployments.find(
        (x) => x.uid === cancel[1] && x.teamId === teamId,
      );
      if (!d) return err(404, "not_found", "Deployment not found");
      if (!["QUEUED", "INITIALIZING", "BUILDING"].includes(d.readyState))
        return err(400, "bad_request", "Deployment is not cancelable");
      d.readyState = "CANCELED";
      const r = this.render(d);
      return { status: 200, body: { ...r, id: r.uid, uid: undefined } };
    }
    const alias = p.match(
      /^\/(v10|v1)\/projects\/([^/]+)\/(promote|rollback)\/([^/]+)$/,
    );
    if (method === "POST" && alias) {
      const [, , projectId, kind, deploymentId] = alias;
      const project = this.projects.find(
        (x) => x.id === projectId && x.teamId === teamId,
      );
      const d = this.deployments.find(
        (x) => x.uid === deploymentId && x.projectId === projectId,
      );
      if (!project || !d) return err(404, "not_found", "Not found");
      if (d.readyState !== "READY" || d.target !== "production")
        return err(422, "invalid_deployment", "Not a production deployment");
      if (kind === "rollback") {
        const team = this.teams.get(teamId);
        const live = this.deployments.find(
          (x) => x.uid === project.liveProductionId,
        );
        const previous = this.deployments
          .filter(
            (x) =>
              x.projectId === projectId &&
              x.target === "production" &&
              x.readyState === "READY" &&
              live &&
              x.createdAt < live.createdAt,
          )
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        if (team?.plan === "hobby" && previous?.uid !== d.uid)
          return err(
            402,
            "plan_limit",
            "Hobby can roll back to the previous deployment only",
          );
      }
      project.alias = {
        type: kind as "promote" | "rollback",
        jobStatus: "succeeded",
        requestedAt: now,
        toDeploymentId: d.uid,
        fromDeploymentId: project.liveProductionId ?? null,
      };
      project.liveProductionId = d.uid;
      return { status: kind === "promote" ? 202 : 201, body: null };
    }
    return err(404, "not_found", `no write route ${method} ${p}`);
  }

  private render(d: FakeDeployment) {
    return {
      uid: d.uid,
      name: d.name,
      projectId: d.projectId,
      url: `${d.name}-${d.uid.slice(4, 10).toLowerCase()}.vercel.app`,
      created: d.createdAt,
      createdAt: d.createdAt,
      buildingAt: d.buildingAt ?? d.createdAt + 1000,
      ready:
        d.ready ??
        (d.readyState === "READY" ? d.createdAt + 61_000 : undefined),
      readyState: d.readyState,
      state: d.readyState,
      target: d.target,
      source: d.source ?? "git",
      creator: {
        uid: "user_test1",
        username: "example-user",
        email: "user@example.com",
      },
      isRollbackCandidate:
        d.target === "production" && d.readyState === "READY",
      meta: {
        ...(d.meta ?? {}),
        githubCommitSha: d.sha,
        githubCommitRef: d.ref ?? "main",
        githubCommitMessage: d.message ?? "chore: example change",
        githubCommitAuthorName: "Example Person",
        githubCommitAuthorLogin: "example-user",
      },
      inspectorUrl: `https://vercel.com/example/${d.name}/${d.uid}`,
    };
  }
}
