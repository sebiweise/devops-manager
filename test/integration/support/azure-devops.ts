import type { Fetch } from "@/server/azure/client";

/**
 * An in-memory Azure DevOps (and Microsoft Entra token endpoint) for the
 * integration tests (design addendum M7 §9), in the style of FakeVercel:
 * `fetch()` returns an injectable fetch that answers dev.azure.com and
 * login.microsoftonline.com and records every call.
 *
 * - Auth: Basic with a PAT (scopes per token) or Bearer with a token the
 *   fake Entra issued for a known client secret. Unknown credentials answer
 *   401 (or 203 with an HTML sign-in page, `signInPageFor203`).
 * - Stateful scenario builders: addBuild, advance, retry (attempt-2 records,
 *   a previous-attempt timeline, a new finishTime and lastChangedDate).
 * - $top + continuation paging, minTime/maxTime/queryOrder/buildIds/
 *   definitions/statusFilter; timeline changeId; pools, agents, job
 *   requests, resourceusage (ok, 404 or a changed shape); hooks, previewRun,
 *   build and stage PATCH, tags, logs.
 * - Faults: failNext (status, body, headers, e.g. 429 or 200 with
 *   Retry-After), dropAfterSend (a write applied, then a network error).
 * - Every payload carries identities and e-mail addresses (the client must
 *   drop them). All names and ids are placeholders.
 */

export const FAKE_ORG = "contoso-ci";
export const FAKE_ORG_ID = "00000000-0000-4000-8000-000000000001";
export const OTHER_ORG = "fabrikam";
export const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000002";
export const P1 = "00000000-0000-4000-8000-000000000011";
export const P2 = "00000000-0000-4000-8000-000000000012";
export const P3 = "00000000-0000-4000-8000-000000000013";
/** A person the client must never store. */
export const PII_NAME = "Example Person";
export const PII_EMAIL = "person@example.com";

export type Scope = "projects" | "pools" | "build" | "execute" | "hooks";

export type FakeCall = {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
};

type Record_ = {
  id: string;
  parentId?: string;
  type: "Stage" | "Job" | "Task";
  name: string;
  identifier?: string;
  state: "pending" | "inProgress" | "completed";
  result?: string | null;
  startTime?: string | null;
  finishTime?: string | null;
  attempt: number;
  previousAttempts?: Array<{
    attempt: number;
    timelineId: string;
    recordId: string;
  }>;
  workerName?: string;
  log?: { id: number };
  issues?: Array<{ type: string; message: string }>;
};

export type FakeBuild = {
  id: number;
  projectId: string;
  definitionId: number;
  status: string;
  result?: string | null;
  reason: string;
  queueTime: number;
  startTime?: number | null;
  finishTime?: number | null;
  lastChangedDate: number;
  sourceBranch: string;
  sourceVersion: string;
  triggerInfo?: Record<string, string>;
  tags: string[];
  records: Record_[];
  previous: Map<string, Record_[]>;
  changeId: number;
  logs: Map<number, string>;
};

export type FakeDefinition = {
  id: number;
  projectId: string;
  name: string;
  repoFullName: string | null;
  repoType?: string;
};

const iso = (ms: number) => new Date(ms).toISOString();
const uuid = (n: number) =>
  `00000000-0000-4000-9000-${n.toString(16).padStart(12, "0")}`;

export class FakeAzureDevOps {
  readonly calls: FakeCall[] = [];
  /** PAT → org and scopes. */
  readonly pats = new Map<
    string,
    { org: string; scopes: Set<Scope>; revoked?: boolean }
  >();
  /** Entra: client secret → org and scopes; issued bearer tokens. */
  readonly clients = new Map<
    string,
    { tenantId: string; clientId: string; org: string; scopes: Set<Scope> }
  >();
  private readonly bearer = new Map<string, string>();
  readonly orgIds = new Map<string, string>([
    [FAKE_ORG, FAKE_ORG_ID],
    [OTHER_ORG, OTHER_ORG_ID],
  ]);
  projects: Array<{
    id: string;
    name: string;
    visibility: "private" | "public";
    org: string;
  }> = [];
  definitions: FakeDefinition[] = [];
  builds: FakeBuild[] = [];
  pools = [
    {
      id: 9,
      name: "Azure Pipelines",
      isHosted: true,
      poolType: "automation",
      size: 10,
    },
    {
      id: 12,
      name: "self-hosted-pool",
      isHosted: false,
      poolType: "automation",
      size: 2,
    },
  ];
  agents = new Map<
    number,
    Array<{
      id: number;
      name: string;
      status: string;
      enabled: boolean;
      assigned?: boolean;
    }>
  >([[12, [{ id: 1, name: "agent-1", status: "online", enabled: true }]]]);
  jobRequests = new Map<number, Array<Record<string, unknown>>>();
  /** ok | not_found | changed */
  resourceUsage: "ok" | "not_found" | "changed" = "ok";
  usage = {
    totalMinutes: 1800,
    totalCount: 1,
    isPremium: false,
    usedMinutes: 900,
    usedCount: 1,
  };
  jobRequestsMode: "ok" | "not_found" = "ok";
  subscriptions: Array<{
    id: string;
    eventType: string;
    status: string;
    projectId: string;
    url: string;
  }> = [];
  /** connectionData answers 404 (the name fallback). */
  connectionDataMissing = false;
  /** Unknown credentials: 203 + HTML instead of 401. */
  signInPageFor203 = false;
  private overrides: Array<{
    match: string;
    status: number;
    body: unknown;
    headers?: Record<string, string>;
    html?: boolean;
  }> = [];
  /** Path substrings whose next write is applied, then the connection drops. */
  dropAfterSend: string[] = [];
  /** Extra headers on every response (e.g. X-RateLimit-*). */
  everyResponseHeaders: Record<string, string> = {};
  /** Called before each response (tests advance a clock). */
  onRequest?: (call: FakeCall) => void;
  now: () => number = Date.now;
  private seq = 1;
  private recSeq = 1;

  addPat(
    pat: string,
    org = FAKE_ORG,
    scopes: Scope[] = ["projects", "pools", "build"],
  ) {
    this.pats.set(pat, { org, scopes: new Set(scopes) });
  }

  addClient(c: {
    tenantId: string;
    clientId: string;
    secret: string;
    org?: string;
    scopes?: Scope[];
  }) {
    this.clients.set(c.secret, {
      tenantId: c.tenantId,
      clientId: c.clientId,
      org: c.org ?? FAKE_ORG,
      scopes: new Set(c.scopes ?? ["projects", "pools", "build"]),
    });
  }

  failNext(
    match: string,
    status: number,
    body: unknown = {},
    headers?: Record<string, string>,
    html = false,
  ) {
    this.overrides.push({ match, status, body, headers, html });
  }

  callsTo(fragment: string, method?: string) {
    return this.calls.filter(
      (c) => c.path.includes(fragment) && (!method || c.method === method),
    );
  }

  /** A build with one stage and its jobs (all of attempt 1). */
  addBuild(spec: {
    id?: number;
    projectId?: string;
    definitionId: number;
    status?: "notStarted" | "inProgress" | "completed" | "postponed";
    result?: string | null;
    reason?: string;
    queuedAt: number;
    durationS?: number;
    branch?: string;
    sha?: string;
    pr?: { number: number; sourceSha: string; sourceBranch: string };
    jobs?: Array<{
      name: string;
      result?: string;
      durationS?: number;
      worker?: string;
      issues?: string[];
    }>;
    tags?: string[];
  }): FakeBuild {
    const id = spec.id ?? 1000 + this.seq++;
    const status = spec.status ?? "completed";
    const start = status === "notStarted" ? null : spec.queuedAt + 30_000;
    const dur = spec.durationS ?? 300;
    const finish =
      status === "completed" ? (start ?? spec.queuedAt) + dur * 1000 : null;
    const stageId = uuid(this.recSeq++);
    const jobs = (spec.jobs ?? [{ name: "build" }]).map((j, i) => {
      const jd = j.durationS ?? Math.round(dur / (spec.jobs?.length ?? 1));
      const js = start != null ? start + i * jd * 1000 : null;
      return {
        id: uuid(this.recSeq++),
        parentId: stageId,
        type: "Job" as const,
        name: j.name,
        identifier: `Build.${j.name}`,
        state:
          status === "completed"
            ? ("completed" as const)
            : status === "inProgress"
              ? ("inProgress" as const)
              : ("pending" as const),
        result:
          status === "completed"
            ? (j.result ?? spec.result ?? "succeeded")
            : null,
        startTime: js != null ? iso(js) : null,
        finishTime:
          status === "completed" && js != null ? iso(js + jd * 1000) : null,
        attempt: 1,
        workerName: j.worker ?? "Azure Pipelines 2",
        log: { id: 10 + i },
        issues: (j.issues ?? []).map((m) => ({ type: "error", message: m })),
      };
    });
    const b: FakeBuild = {
      id,
      projectId: spec.projectId ?? P1,
      definitionId: spec.definitionId,
      status,
      result: status === "completed" ? (spec.result ?? "succeeded") : null,
      reason: spec.reason ?? (spec.pr ? "pullRequest" : "individualCI"),
      queueTime: spec.queuedAt,
      startTime: start,
      finishTime: finish,
      lastChangedDate: finish ?? start ?? spec.queuedAt,
      sourceBranch: spec.pr
        ? `refs/pull/${spec.pr.number}/merge`
        : `refs/heads/${spec.branch ?? "main"}`,
      sourceVersion: spec.sha ?? id.toString(16).padStart(40, "a"),
      triggerInfo: spec.pr
        ? {
            "pr.number": String(spec.pr.number),
            "pr.sourceSha": spec.pr.sourceSha,
            "pr.sourceBranch": `refs/heads/${spec.pr.sourceBranch}`,
          }
        : {},
      tags: spec.tags ?? [],
      records: [
        {
          id: stageId,
          type: "Stage",
          name: "Build",
          identifier: "Build",
          state: jobs.every((j) => j.state === "completed")
            ? "completed"
            : jobs.some((j) => j.state === "inProgress")
              ? "inProgress"
              : "pending",
          result:
            status === "completed"
              ? jobs.some((j) => j.result === "failed")
                ? "failed"
                : jobs.some((j) => j.result === "canceled")
                  ? "canceled"
                  : "succeeded"
              : null,
          startTime: start != null ? iso(start) : null,
          finishTime: finish != null ? iso(finish) : null,
          attempt: 1,
        },
        ...jobs,
        ...jobs.map((j) => ({
          id: uuid(this.recSeq++),
          parentId: j.id,
          type: "Task" as const,
          name: `Run ${j.name}`,
          state: j.state,
          result: j.result,
          attempt: 1,
        })),
      ],
      previous: new Map(),
      changeId: 1,
      logs: new Map(
        jobs.map((j, i) => [
          10 + i,
          `2026-11-13T10:00:00.0000000Z ##[section]Starting ${j.name}\n2026-11-13T10:00:01.0000000Z echo token\n`,
        ]),
      ),
    };
    this.builds.push(b);
    return b;
  }

  /** Moves a build forward (notStarted → inProgress → completed). */
  advance(
    id: number,
    to: "inProgress" | "completed",
    result = "succeeded",
    at = this.now(),
  ) {
    const b = this.builds.find((x) => x.id === id)!;
    b.status = to;
    if (to === "inProgress") b.startTime = at;
    if (to === "completed") {
      b.result = result;
      b.finishTime = at;
      b.startTime ??= at - 60_000;
      for (const r of b.records) {
        if (r.type === "Task") continue;
        r.state = "completed";
        r.result = result;
        r.startTime ??= iso(b.startTime);
        r.finishTime = iso(at);
      }
    }
    b.lastChangedDate = at;
    b.changeId++;
  }

  /**
   * Retries the failed jobs of a finished build: the current timeline gets
   * attempt-2 records (with previousAttempts pointing at a previous
   * timeline holding attempt 1), the build finishes later with `result`.
   */
  retry(id: number, result = "succeeded", at = this.now()) {
    const b = this.builds.find((x) => x.id === id)!;
    const prevId = uuid(900_000 + this.recSeq++);
    const old = b.records.map((r) => ({ ...r }));
    b.previous.set(prevId, old);
    b.records = b.records.map((r) => {
      if (r.type === "Task") return r;
      const failed = r.result === "failed" || r.result === "canceled";
      if (r.type === "Job" && !failed) return r;
      return {
        ...r,
        attempt: r.attempt + 1,
        previousAttempts: [
          { attempt: r.attempt, timelineId: prevId, recordId: r.id },
        ],
        result,
        state: "completed" as const,
        startTime: iso(at - 120_000),
        finishTime: iso(at),
      };
    });
    b.status = "completed";
    b.result = result;
    b.finishTime = at;
    b.lastChangedDate = at;
    b.changeId++;
  }

  fetch(): Fetch {
    return async (input, init) => {
      const url = new URL(input);
      const method = init.method ?? "GET";
      const body =
        typeof init.body === "string"
          ? init.body.startsWith("{")
            ? (JSON.parse(init.body) as unknown)
            : Object.fromEntries(new URLSearchParams(init.body))
          : undefined;
      const call: FakeCall = {
        method,
        host: url.host,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
      };
      this.calls.push(call);
      this.onRequest?.(call);
      const headers = (init.headers ?? {}) as Record<string, string>;
      const respond = (
        status: number,
        payload: unknown,
        extra: Record<string, string> = {},
      ) =>
        new Response(payload === undefined ? null : JSON.stringify(payload), {
          status,
          headers: {
            "content-type": "application/json; charset=utf-8",
            activityid: `fake-activity-${this.calls.length}`,
            ...this.everyResponseHeaders,
            ...extra,
          },
        });
      const html = (status: number) =>
        new Response("<html><body>Sign in to your account</body></html>", {
          status,
          headers: { "content-type": "text/html" },
        });

      // ---------- Microsoft Entra ----------
      if (url.host === "login.microsoftonline.com") {
        const form = body as Record<string, string>;
        const c = this.clients.get(form?.client_secret ?? "");
        const tenant = url.pathname.split("/")[1];
        if (
          !c ||
          c.clientId !== form.client_id ||
          c.tenantId !== tenant ||
          form.scope !== "499b84ac-1321-427f-aa17-267ca6975798/.default" ||
          form.grant_type !== "client_credentials"
        )
          return respond(401, {
            error: "invalid_client",
            error_codes: [7000215],
            error_description: `AADSTS7000215 for ${form?.client_id}`,
          });
        const token = `eyJfake.${Buffer.from(String(this.calls.length)).toString("base64url")}.signature`;
        this.bearer.set(token, form.client_secret!);
        return respond(200, {
          access_token: token,
          expires_in: 3599,
          token_type: "Bearer",
        });
      }
      if (url.host !== "dev.azure.com")
        return respond(404, { message: "unknown host" });

      const [rawOrg, ...rest] = url.pathname.split("/").filter(Boolean);
      const org = decodeURIComponent(rawOrg ?? "");
      const p = "/" + rest.map(decodeURIComponent).join("/");

      const o = this.overrides.findIndex((x) => url.pathname.includes(x.match));
      if (o >= 0) {
        const [hit] = this.overrides.splice(o, 1);
        if (hit!.html) return html(hit!.status);
        return respond(hit!.status, hit!.body, hit!.headers);
      }

      // Authentication.
      const auth = headers.authorization ?? "";
      let identity: { org: string; scopes: Set<Scope> } | null = null;
      if (auth.startsWith("Basic ")) {
        const pat = Buffer.from(auth.slice(6), "base64")
          .toString("utf8")
          .replace(/^:/, "");
        const t = this.pats.get(pat);
        if (t && !t.revoked) identity = t;
      } else if (auth.startsWith("Bearer ")) {
        const secret = this.bearer.get(auth.slice(7));
        const c = secret ? this.clients.get(secret) : undefined;
        if (c) identity = c;
      }
      if (!identity || identity.org !== org)
        return this.signInPageFor203
          ? html(203)
          : respond(401, { message: "TF400813: not authorized" });
      const need = (s: Scope) =>
        identity!.scopes.has(s) ||
        (s === "build" && identity!.scopes.has("execute"));
      const forbidden = () =>
        respond(403, { message: "Access denied: missing scope" });

      if (p === "/_apis/connectionData") {
        if (this.connectionDataMissing)
          return respond(404, { message: "not found" });
        return respond(200, {
          instanceId: this.orgIds.get(org),
          authenticatedUser: {
            id: uuid(777),
            providerDisplayName: PII_NAME,
            properties: { Account: { $value: PII_EMAIL } },
          },
          locationServiceData: { serviceOwner: uuid(1) },
        });
      }
      if (p === "/_apis/projects") {
        if (!need("projects")) return forbidden();
        const all = this.projects.filter((x) => x.org === org);
        return respond(200, {
          count: all.length,
          value: all.map((x) => ({
            ...x,
            state: "wellFormed",
            description: `owned by ${PII_EMAIL}`,
          })),
        });
      }
      if (p === "/_apis/distributedtask/pools") {
        if (!need("pools")) return forbidden();
        return respond(200, {
          count: this.pools.length,
          value: this.pools.map((x) => ({
            ...x,
            owner: { displayName: PII_NAME, uniqueName: PII_EMAIL },
            createdBy: { displayName: PII_NAME },
          })),
        });
      }
      const agents = p.match(
        /^\/_apis\/distributedtask\/pools\/(\d+)\/agents$/,
      );
      if (agents) {
        if (!need("pools")) return forbidden();
        const list = this.agents.get(Number(agents[1])) ?? [];
        return respond(200, {
          count: list.length,
          value: list.map((a) => ({
            ...a,
            version: "4.250.0",
            osDescription: "Linux",
            assignedRequest: a.assigned
              ? { requestId: 1, owner: { id: 1, name: PII_NAME } }
              : undefined,
          })),
        });
      }
      const jr = p.match(
        /^\/_apis\/distributedtask\/pools\/(\d+)\/jobrequests$/,
      );
      if (jr) {
        if (this.jobRequestsMode === "not_found")
          return respond(404, { message: "route not found" });
        const list = this.jobRequests.get(Number(jr[1])) ?? [];
        return respond(200, { count: list.length, value: list });
      }
      if (p === "/_apis/distributedtask/resourceusage") {
        if (this.resourceUsage === "not_found")
          return respond(404, { message: "not found" });
        if (this.resourceUsage === "changed")
          return respond(200, {
            something: "else",
            resourceLimit: "unexpected",
          });
        return respond(200, {
          resourceLimit: {
            totalMinutes: this.usage.totalMinutes,
            totalCount: this.usage.totalCount,
            isPremium: this.usage.isPremium,
            isHosted: true,
            parallelismTag: "Private",
          },
          usedMinutes: this.usage.usedMinutes,
          usedCount: this.usage.usedCount,
          runningRequests: [{ owner: { name: PII_NAME } }],
        });
      }
      if (p === "/_apis/hooks/subscriptions") {
        if (method === "GET")
          return respond(200, {
            count: this.subscriptions.length,
            value: this.subscriptions.map((s) => ({
              id: s.id,
              eventType: s.eventType,
              status: s.status,
              publisherInputs: { projectId: s.projectId },
              consumerInputs: { url: s.url, basicAuthPassword: "********" },
              createdBy: { displayName: PII_NAME },
            })),
          });
        if (!need("hooks")) return forbidden();
        const b = body as {
          eventType: string;
          resourceVersion?: string;
          publisherInputs: { projectId: string };
          consumerInputs: { url: string };
        };
        // Mirrors the event reference: the pipelines events use
        // 5.1-preview.1, build.complete 2.0.
        const version = b.eventType.startsWith("ms.vss-pipelines.")
          ? "5.1-preview.1"
          : "2.0";
        if (b.resourceVersion !== version)
          return respond(400, {
            message: "unsupported resource version",
          });
        const s = {
          id: uuid(500_000 + this.seq++),
          eventType: b.eventType,
          status: "enabled",
          projectId: b.publisherInputs.projectId,
          url: b.consumerInputs.url,
        };
        this.subscriptions.push(s);
        return respond(200, { id: s.id, eventType: s.eventType });
      }
      const sub = p.match(/^\/_apis\/hooks\/subscriptions\/([0-9a-f-]{36})$/);
      if (sub && method === "DELETE") {
        this.subscriptions = this.subscriptions.filter((s) => s.id !== sub[1]);
        return respond(204, undefined);
      }

      // Project-scoped routes.
      const m = p.match(/^\/([0-9a-f-]{36})(\/.*)$/);
      if (!m) return respond(404, { message: `no route ${p}` });
      const projectId = m[1]!;
      const route = m[2]!;
      if (!this.projects.some((x) => x.id === projectId && x.org === org))
        return respond(404, { message: "project not found" });
      if (route === "/_apis/build/definitions") {
        if (!need("build")) return forbidden();
        const all = this.definitions.filter((d) => d.projectId === projectId);
        const top = Number(url.searchParams.get("$top") ?? 100);
        const from = Number(url.searchParams.get("continuationToken") ?? 0);
        const page = all.slice(from, from + top);
        return respond(
          200,
          {
            count: page.length,
            value: page.map((d) => ({
              id: d.id,
              name: d.name,
              path: "\\",
              queueStatus: "enabled",
              project: { id: projectId },
              authoredBy: { displayName: PII_NAME, uniqueName: PII_EMAIL },
              repository: {
                id: d.repoFullName,
                name: d.repoFullName,
                type: d.repoType ?? "GitHub",
                defaultBranch: "refs/heads/main",
              },
              process: { type: 2, yamlFilename: "azure-pipelines.yml" },
            })),
          },
          from + top < all.length
            ? { "x-ms-continuationtoken": String(from + top) }
            : {},
        );
      }
      if (route === "/_apis/build/builds" && method === "GET") {
        if (!need("build")) return forbidden();
        const q = url.searchParams;
        let list = this.builds.filter((b) => b.projectId === projectId);
        const ids = q.get("buildIds");
        if (ids) {
          const set = new Set(ids.split(",").map(Number));
          list = list.filter((b) => set.has(b.id));
        }
        const defs = q.get("definitions");
        if (defs) {
          const set = new Set(defs.split(",").map(Number));
          list = list.filter((b) => set.has(b.definitionId));
        }
        const status = q.get("statusFilter");
        if (status) list = list.filter((b) => b.status === status);
        const order = q.get("queryOrder") ?? "queueTimeDescending";
        const key = (b: FakeBuild) =>
          order.startsWith("finishTime") ? (b.finishTime ?? 0) : b.queueTime;
        const min = q.get("minTime") ? Date.parse(q.get("minTime")!) : null;
        const max = q.get("maxTime") ? Date.parse(q.get("maxTime")!) : null;
        if (min != null) list = list.filter((b) => key(b) >= min);
        if (max != null) list = list.filter((b) => key(b) < max);
        list.sort(
          (a, b) =>
            (order.endsWith("Ascending") ? key(a) - key(b) : key(b) - key(a)) ||
            a.id - b.id,
        );
        const top = Number(q.get("$top") ?? 1000);
        const from = Number(q.get("continuationToken") ?? 0);
        const page = list.slice(from, from + top);
        return respond(
          200,
          { count: page.length, value: page.map((b) => this.renderBuild(b)) },
          from + top < list.length
            ? { "x-ms-continuationtoken": String(from + top) }
            : {},
        );
      }
      const one = route.match(/^\/_apis\/build\/builds\/(\d+)(\/.*)?$/);
      if (one) {
        const b = this.builds.find(
          (x) => x.id === Number(one[1]) && x.projectId === projectId,
        );
        if (!b) return respond(404, { message: "build not found" });
        const tail = one[2] ?? "";
        const tl = tail.match(/^\/timeline(?:\/([0-9a-f-]{36}))?$/);
        if (tl && method === "GET") {
          const recs = tl[1] ? b.previous.get(tl[1]) : b.records;
          if (!recs) return respond(404, { message: "timeline not found" });
          return respond(200, {
            id: tl[1] ?? uuid(1_000_000 + b.id),
            changeId: b.changeId,
            lastChangedBy: uuid(7),
            records: recs,
          });
        }
        if (tail === "/logs" && method === "GET")
          return respond(200, {
            count: b.logs.size,
            value: [...b.logs].map(([id, text]) => ({
              id,
              type: "Container",
              lineCount: text.replace(/\n$/, "").split("\n").length,
            })),
          });
        const log = tail.match(/^\/logs\/(\d+)$/);
        if (log && method === "GET") {
          let text = b.logs.get(Number(log[1]));
          if (text == null) return respond(404, { message: "log not found" });
          // startLine/endLine: 1-based and inclusive.
          const start = Number(url.searchParams.get("startLine") ?? 0);
          const end = Number(url.searchParams.get("endLine") ?? 0);
          if (start > 0 || end > 0) {
            const lines = text.replace(/\n$/, "").split("\n");
            text = lines
              .slice(Math.max(0, start - 1), end > 0 ? end : undefined)
              .join("\n");
          }
          return new Response(text, {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }
        if (method !== "GET" && !need("execute")) return forbidden();
        const drop = () => {
          const i = this.dropAfterSend.findIndex((d) =>
            url.pathname.includes(d),
          );
          if (i >= 0) {
            this.dropAfterSend.splice(i, 1);
            throw new TypeError("fetch failed: socket hang up");
          }
        };
        const tag = tail.match(/^\/tags\/(.+)$/);
        if (tag && method === "PUT") {
          b.tags.push(tag[1]!);
          return respond(200, b.tags);
        }
        const stage = tail.match(/^\/stages\/([A-Za-z0-9_]+)$/);
        if (stage && method === "PATCH") {
          const s = b.records.find(
            (r) => r.type === "Stage" && r.identifier === stage[1],
          );
          if (!s) return respond(404, { message: "stage not found" });
          if (b.status !== "completed")
            return respond(400, { message: "build not finished" });
          b.status = "inProgress";
          b.lastChangedDate = this.now();
          drop();
          return respond(200, undefined);
        }
        if (tail === "" && method === "PATCH") {
          const bb = body as { status?: string };
          if (url.searchParams.get("retry") === "true") {
            if (b.status !== "completed")
              return respond(400, { message: "build is not finished" });
            b.status = "inProgress";
            b.lastChangedDate = this.now();
          } else if (bb?.status === "cancelling") {
            if (b.status === "completed")
              return respond(400, { message: "build already finished" });
            b.status = "cancelling";
            b.lastChangedDate = this.now();
          }
          drop();
          return respond(200, this.renderBuild(b));
        }
      }
      const run = route.match(/^\/_apis\/pipelines\/(\d+)\/runs$/);
      if (run && method === "POST") {
        if (!need("execute")) return forbidden();
        const def = this.definitions.find(
          (d) => d.id === Number(run[1]) && d.projectId === projectId,
        );
        if (!def) return respond(404, { message: "pipeline not found" });
        const b = body as {
          previewRun?: boolean;
          resources?: { repositories?: { self?: { refName?: string } } };
        };
        if (b?.previewRun)
          return respond(200, {
            id: -1,
            finalYaml: "steps: []",
            state: "unknown",
          });
        const ref =
          b?.resources?.repositories?.self?.refName ?? "refs/heads/main";
        const nb = this.addBuild({
          projectId,
          definitionId: def.id,
          status: "notStarted",
          reason: "manual",
          queuedAt: this.now(),
          branch: ref.replace(/^refs\/heads\//, ""),
        });
        const i = this.dropAfterSend.findIndex((d) => url.pathname.includes(d));
        if (i >= 0) {
          this.dropAfterSend.splice(i, 1);
          throw new TypeError("fetch failed: socket hang up");
        }
        return respond(200, {
          id: nb.id,
          name: String(nb.id),
          state: "inProgress",
          pipeline: { id: def.id },
        });
      }
      return respond(404, { message: `no route ${method} ${route}` });
    };
  }

  renderBuild(b: FakeBuild) {
    return {
      id: b.id,
      buildNumber: `20261113.${b.id}`,
      status: b.status,
      result: b.result ?? undefined,
      reason: b.reason,
      queueTime: iso(b.queueTime),
      startTime: b.startTime ? iso(b.startTime) : undefined,
      finishTime: b.finishTime ? iso(b.finishTime) : undefined,
      lastChangedDate: iso(b.lastChangedDate),
      sourceBranch: b.sourceBranch,
      sourceVersion: b.sourceVersion,
      definition: { id: b.definitionId, name: `def-${b.definitionId}` },
      project: { id: b.projectId, name: "project-a" },
      repository: { id: "example-org/repo-b", type: "GitHub" },
      triggerInfo: b.triggerInfo,
      tags: b.tags,
      requestedFor: {
        displayName: PII_NAME,
        uniqueName: PII_EMAIL,
        id: uuid(777),
      },
      requestedBy: { displayName: PII_NAME, uniqueName: PII_EMAIL },
      lastChangedBy: { displayName: PII_NAME, uniqueName: PII_EMAIL },
      _links: { web: { href: "https://evil.example.com/redirect" } },
      url: "https://evil.example.com/build",
    };
  }
}
