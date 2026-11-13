import { z } from "zod";

/**
 * Read-only Vercel REST client (design addendum §6, M5). Pure: no database,
 * no logging, `fetch` injected, so every branch is unit-tested and the
 * integration tests run against an in-memory Vercel.
 *
 * - The base URL is a constant and never configurable; requests for team
 *   resources always carry `teamId`.
 * - Every request is a GET (M5 has no mutation; a unit test asserts it).
 *   A `decrypt` parameter is refused at type level and at runtime, so env
 *   var values can never be requested.
 * - Responses pass zod schemas that whitelist the fields the app stores:
 *   user names, e-mail addresses, avatars, env arrays and every other field
 *   are dropped at this boundary.
 * - 10 s timeout and a 5 MB response cap per request.
 * - Errors become `VercelError { status, code, requestId (x-vercel-id),
 *   retryAt }`. A 429's retry time comes from the body's `limit.resetMs`,
 *   then `retry-after`, then now + 60 s.
 *
 * API facts (versions, pagination, fields) are recorded in docs/VERCEL.md.
 */

export const VERCEL_API = "https://api.vercel.com";
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const PAGE_LIMIT = 100;

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** What a response told about the rate limit (headers, if Vercel sent them). */
export type VercelRateInfo = {
  limit: number;
  remaining: number;
  resetAt: Date;
};

export class VercelError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string | null,
    message: string,
    readonly requestId: string | null,
    readonly path: string,
    /** 429: when the limit resets. */
    readonly retryAt: Date | null = null,
    /** 403 with `invalidToken` or `missingToken`. */
    readonly tokenRejected: boolean = false,
  ) {
    super(message);
    this.name = "VercelError";
  }

  /** The token no longer works: 401, or 403 that names the token. */
  get revoked(): boolean {
    return this.status === 401 || (this.status === 403 && this.tokenRejected);
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

/** A request aborted by its timeout. */
export class VercelTimeout extends VercelError {
  constructor(path: string) {
    super(504, "timeout", "Vercel request timed out", null, path);
    this.name = "VercelTimeout";
  }
}

// ---------- schemas (whitelists) ----------

const ms = z.number().finite().nonnegative();
const optMs = ms.nullish();
const str = z.string().max(500);

export const userSchema = z.object({
  user: z.object({
    id: str,
    defaultTeamId: str.nullish(),
  }),
});
export type VercelUser = { id: string; defaultTeamId: string | null };

const tokenScopeSchema = z.object({
  type: str,
  teamId: str.nullish(),
  expiresAt: optMs,
});

export const tokenSchema = z.object({
  token: z.object({
    id: str,
    expiresAt: optMs,
    scopes: z.array(tokenScopeSchema).max(200).nullish(),
  }),
});
export type VercelTokenInfo = {
  expiresAt: Date | null;
  /** Team ids of team scopes; `full` when the token has a user scope. */
  teamIds: string[];
  full: boolean;
};

export const teamSchema = z.object({
  id: str,
  slug: str,
  name: str.nullish(),
  billing: z.object({ plan: str.nullish() }).nullish(),
});
export type VercelTeam = {
  id: string;
  slug: string;
  name: string;
  plan: string | null;
};

export const teamsSchema = z.object({
  teams: z.array(teamSchema).max(500),
  pagination: z.object({ next: z.number().nullish() }).nullish(),
});

const linkSchema = z
  .object({
    type: str.nullish(),
    org: str.nullish(),
    repo: str.nullish(),
    repoId: z.union([z.number(), z.string()]).nullish(),
    productionBranch: str.nullish(),
  })
  .nullish();

export const projectSchema = z.object({
  id: str,
  name: str,
  framework: str.nullish(),
  link: linkSchema,
  paused: z.boolean().nullish(),
  targets: z
    .object({
      production: z
        .object({
          id: str,
        })
        .nullish(),
    })
    .nullish(),
});

export const projectsSchema = z.object({
  projects: z.array(projectSchema).max(1000),
  pagination: z
    .object({ next: z.union([z.number(), z.string()]).nullish() })
    .nullish(),
});

export type VercelProjectInfo = {
  id: string;
  name: string;
  framework: string | null;
  linkType: string | null;
  linkRepoId: bigint | null;
  /** "owner/name" */
  linkRepo: string | null;
  productionBranch: string | null;
  paused: boolean;
  liveProductionId: string | null;
};

const STATES = [
  "QUEUED",
  "INITIALIZING",
  "BUILDING",
  "READY",
  "ERROR",
  "CANCELED",
  "BLOCKED",
  "DELETED",
] as const;
export type VercelState = (typeof STATES)[number] | "UNKNOWN";

/** Only the git commit fields of `meta`; author names and logins are dropped. */
const metaSchema = z
  .object({
    githubCommitSha: str.nullish(),
    githubCommitRef: str.nullish(),
    githubCommitMessage: z.string().nullish(),
    gitlabCommitSha: str.nullish(),
    gitlabCommitRef: str.nullish(),
    gitlabCommitMessage: z.string().nullish(),
    bitbucketCommitSha: str.nullish(),
    bitbucketCommitRef: str.nullish(),
    bitbucketCommitMessage: z.string().nullish(),
  })
  .nullish();

export const deploymentSchema = z.object({
  /** `uid` in the list (v7), `id` in the single read (v13). */
  uid: str.nullish(),
  id: str.nullish(),
  /** The project name. */
  name: str.nullish(),
  projectId: str.nullish(),
  url: str.nullish(),
  created: optMs,
  createdAt: optMs,
  buildingAt: optMs,
  ready: optMs,
  readyState: str.nullish(),
  state: str.nullish(),
  readySubstate: str.nullish(),
  target: str.nullish(),
  source: str.nullish(),
  errorCode: str.nullish(),
  isRollbackCandidate: z.boolean().nullish(),
  meta: metaSchema,
  gitSource: z
    .object({ sha: str.nullish(), ref: str.nullish() })
    .transform((g) => ({ sha: g.sha ?? null, ref: g.ref ?? null }))
    .nullish(),
});

export const deploymentsSchema = z.object({
  deployments: z.array(deploymentSchema).max(1000),
  pagination: z.object({ next: z.number().nullish() }).nullish(),
});

export type VercelDeploymentInfo = {
  id: string;
  projectId: string;
  projectName: string | null;
  target: string;
  state: VercelState;
  readySubstate: string | null;
  url: string | null;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  creatorKind: string | null;
  errorCode: string | null;
  isRollbackCandidate: boolean;
  createdAt: Date;
  buildingAt: Date | null;
  readyAt: Date | null;
  buildMs: number | null;
};

// ---------- mappers (pure, exported for tests) ----------

const HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/i;
const SHA = /^[0-9a-f]{7,64}$/i;

/** `deployment.source` to the stored creator kind (never a user name). */
export function creatorKindOf(
  source: string | null | undefined,
): string | null {
  switch (source) {
    case "git":
    case "import":
    case "import/repo":
    case "clone/repo":
      return "git";
    case "cli":
      return "cli";
    case "redeploy":
      return "redeploy";
    case "api-trigger-git-deploy":
    case "git-deploy-hook":
    case "drop":
    case "v0-web":
      return "api";
    default:
      return null;
  }
}

export function stateOf(value: string | null | undefined): VercelState {
  return (STATES as readonly string[]).includes(value ?? "")
    ? (value as VercelState)
    : "UNKNOWN";
}

/** First line, trimmed to 200 characters. */
export function firstLine(message: string | null | undefined): string | null {
  if (!message) return null;
  const line = message.split(/\r?\n/, 1)[0]!.trim();
  return line ? line.slice(0, 200) : null;
}

export function mapDeployment(
  d: z.infer<typeof deploymentSchema>,
  fallbackProjectId?: string,
): VercelDeploymentInfo | null {
  const id = d.uid ?? d.id;
  const projectId = d.projectId ?? fallbackProjectId;
  const created = d.createdAt ?? d.created;
  if (!id || !projectId || created == null) return null;
  const m = d.meta ?? {};
  const sha =
    m.githubCommitSha ??
    m.gitlabCommitSha ??
    m.bitbucketCommitSha ??
    d.gitSource?.sha ??
    null;
  const ref =
    m.githubCommitRef ??
    m.gitlabCommitRef ??
    m.bitbucketCommitRef ??
    d.gitSource?.ref ??
    null;
  const message =
    m.githubCommitMessage ??
    m.gitlabCommitMessage ??
    m.bitbucketCommitMessage ??
    null;
  const host = d.url?.replace(/^https?:\/\//, "").split("/")[0] ?? null;
  const buildingAt = d.buildingAt ? new Date(d.buildingAt) : null;
  const readyAt = d.ready ? new Date(d.ready) : null;
  const state = stateOf(d.readyState ?? d.state);
  return {
    id,
    projectId,
    projectName: d.name ? d.name.slice(0, 100) : null,
    target:
      d.target === "production" || d.target === "staging"
        ? d.target
        : "preview",
    state,
    readySubstate: state === "READY" ? (d.readySubstate ?? null) : null,
    url: host && HOSTNAME.test(host) ? host.toLowerCase() : null,
    branch: ref ? ref.slice(0, 255) : null,
    commitSha: sha && SHA.test(sha) ? sha.toLowerCase() : null,
    commitMessage: firstLine(message),
    creatorKind: creatorKindOf(d.source),
    errorCode:
      state === "ERROR" && d.errorCode ? d.errorCode.slice(0, 64) : null,
    isRollbackCandidate: d.isRollbackCandidate === true,
    createdAt: new Date(created),
    buildingAt,
    readyAt,
    buildMs:
      buildingAt && readyAt && readyAt >= buildingAt
        ? Math.min(readyAt.getTime() - buildingAt.getTime(), 2 ** 31 - 1)
        : null,
  };
}

export function mapProject(
  p: z.infer<typeof projectSchema>,
): VercelProjectInfo {
  const link = p.link ?? null;
  const repoId =
    link?.repoId != null && /^\d{1,20}$/.test(String(link.repoId))
      ? BigInt(link.repoId)
      : null;
  return {
    id: p.id,
    name: p.name,
    framework: p.framework ?? null,
    linkType: link?.type ?? null,
    linkRepoId: link?.type === "github" ? repoId : null,
    linkRepo:
      link?.org && link?.repo
        ? `${link.org}/${link.repo}`.slice(0, 255)
        : (link?.repo ?? null),
    productionBranch: link?.productionBranch ?? null,
    paused: p.paused === true,
    liveProductionId: p.targets?.production?.id ?? null,
  };
}

export function mapToken(t: z.infer<typeof tokenSchema>): VercelTokenInfo {
  const scopes = t.token.scopes ?? [];
  const teamIds = scopes
    .filter((s) => s.type === "team" && s.teamId)
    .map((s) => s.teamId!);
  return {
    expiresAt: t.token.expiresAt ? new Date(t.token.expiresAt) : null,
    teamIds,
    full: scopes.some((s) => s.type === "user"),
  };
}

export function mapTeam(t: z.infer<typeof teamSchema>): VercelTeam {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name ?? t.slug,
    plan: t.billing?.plan ?? null,
  };
}

/** 429 retry time: body `limit.resetMs`, else `retry-after`, else now + 60 s. */
export function retryAtOf(
  body: unknown,
  retryAfter: string | null,
  now: number,
): Date {
  const limit = (
    body as { error?: { limit?: { resetMs?: unknown; reset?: unknown } } }
  )?.error?.limit;
  if (typeof limit?.resetMs === "number" && limit.resetMs > now)
    return new Date(limit.resetMs);
  if (typeof limit?.reset === "number" && limit.reset * 1000 > now)
    return new Date(limit.reset * 1000);
  const after = Number(retryAfter);
  if (retryAfter && Number.isFinite(after) && after > 0)
    return new Date(now + after * 1000);
  return new Date(now + 60_000);
}

// ---------- client ----------

export type Query = Record<
  string,
  string | number | boolean | undefined | null
> & {
  decrypt?: never;
};

export type VercelClientOptions = {
  token: string;
  /** Appended to every team request. */
  teamId?: string | null;
  fetch?: Fetch;
  /** Per request; a function lets the caller bound it by a deadline. */
  timeoutMs?: number | (() => number);
  /** Runs before every request; may throw (e.g. a deadline check). */
  beforeRequest?: () => void;
  now?: () => number;
  /** Called with the rate-limit headers of every response. */
  onRate?: (info: VercelRateInfo) => void;
  /** Called with the request id of every response. */
  onRequestId?: (id: string | null) => void;
};

export interface VercelReadApi {
  getUser(): Promise<VercelUser>;
  /** null when the token may not read its own metadata. */
  getCurrentToken(): Promise<VercelTokenInfo | null>;
  getTeam(teamId: string): Promise<VercelTeam>;
  listTeams(): Promise<VercelTeam[]>;
  listProjects(from?: string | number | null): Promise<{
    projects: VercelProjectInfo[];
    next: string | number | null;
  }>;
  listDeployments(q: {
    since?: number | null;
    until?: number | null;
    projectId?: string;
    limit?: number;
  }): Promise<{ deployments: VercelDeploymentInfo[]; next: number | null }>;
  getDeployment(id: string): Promise<VercelDeploymentInfo | null>;
}

/**
 * The request URL: the fixed base, the path, the query and (for team
 * resources) `teamId`. A `decrypt` parameter is refused: env var values
 * are never requested.
 */
export function vercelUrl(
  path: string,
  query: Query,
  teamId: string | null | undefined,
): URL {
  if (Object.keys(query).some((k) => k.toLowerCase() === "decrypt"))
    throw new Error("decrypt is not allowed: env var values are never read");
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("Vercel paths are absolute");
  const url = new URL(path, VERCEL_API);
  if (url.origin !== VERCEL_API) throw new Error("Vercel API origin only");
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  if (teamId) url.searchParams.set("teamId", teamId);
  return url;
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

const num = (v: string | null) => (v == null || v === "" ? NaN : Number(v));

export function createVercelClient(opts: VercelClientOptions): VercelReadApi {
  const doFetch: Fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const timeoutOf = () =>
    typeof opts.timeoutMs === "function"
      ? opts.timeoutMs()
      : (opts.timeoutMs ?? REQUEST_TIMEOUT_MS);

  async function get<T>(
    path: string,
    query: Query,
    schema: z.ZodType<T>,
    team: boolean,
  ): Promise<T> {
    const url = vercelUrl(path, query, team ? opts.teamId : null);
    opts.beforeRequest?.();
    const signal = AbortSignal.timeout(Math.max(1, timeoutOf()));
    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method: "GET",
        headers: {
          authorization: `Bearer ${opts.token}`,
          accept: "application/json",
        },
        signal,
        redirect: "error",
        cache: "no-store",
      });
    } catch (error) {
      if (signal.aborted) throw new VercelTimeout(path);
      throw new VercelError(
        null,
        "network",
        error instanceof Error ? error.message : "network error",
        null,
        path,
      );
    }
    const requestId = res.headers.get("x-vercel-id");
    opts.onRequestId?.(requestId);
    const limit = num(res.headers.get("x-ratelimit-limit"));
    const remaining = num(res.headers.get("x-ratelimit-remaining"));
    const reset = num(res.headers.get("x-ratelimit-reset"));
    if (opts.onRate && Number.isFinite(limit) && Number.isFinite(remaining))
      opts.onRate({
        limit,
        remaining,
        resetAt: new Date(
          Number.isFinite(reset) ? reset * 1000 : now() + 60_000,
        ),
      });
    const text = await readCapped(res, MAX_RESPONSE_BYTES);
    if (text === null)
      throw new VercelError(
        res.status,
        "too_large",
        "Vercel response larger than 5 MB",
        requestId,
        path,
      );
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const err = (body as { error?: Record<string, unknown> } | null)?.error;
      const code = typeof err?.code === "string" ? err.code : null;
      const message =
        typeof err?.message === "string"
          ? err.message.slice(0, 300)
          : `HTTP ${res.status}`;
      throw new VercelError(
        res.status,
        code,
        message,
        requestId,
        path,
        res.status === 429
          ? retryAtOf(body, res.headers.get("retry-after"), now())
          : null,
        err?.invalidToken === true || err?.missingToken === true,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new VercelError(
        res.status,
        "unexpected_response",
        "Unexpected response from Vercel",
        requestId,
        path,
      );
    return parsed.data;
  }

  return {
    async getUser() {
      const r = await get("/v2/user", {}, userSchema, false);
      return { id: r.user.id, defaultTeamId: r.user.defaultTeamId ?? null };
    },
    async getCurrentToken() {
      try {
        return mapToken(
          await get("/v5/user/tokens/current", {}, tokenSchema, false),
        );
      } catch (error) {
        if (
          error instanceof VercelError &&
          (error.status === 403 || error.status === 404) &&
          !error.tokenRejected
        )
          return null;
        throw error;
      }
    },
    async getTeam(teamId) {
      return mapTeam(
        await get(
          `/v2/teams/${encodeURIComponent(teamId)}`,
          {},
          teamSchema,
          false,
        ),
      );
    },
    async listTeams() {
      const r = await get(
        "/v2/teams",
        { limit: PAGE_LIMIT },
        teamsSchema,
        false,
      );
      return r.teams.map(mapTeam);
    },
    async listProjects(from) {
      const r = await get(
        "/v10/projects",
        { limit: PAGE_LIMIT, from: from ?? undefined },
        projectsSchema,
        true,
      );
      return {
        projects: r.projects.map(mapProject),
        next: r.pagination?.next ?? null,
      };
    },
    async listDeployments(q) {
      const r = await get(
        "/v7/deployments",
        {
          limit: q.limit ?? PAGE_LIMIT,
          since: q.since ?? undefined,
          until: q.until ?? undefined,
          projectId: q.projectId,
        },
        deploymentsSchema,
        true,
      );
      return {
        deployments: r.deployments
          .map((d) => mapDeployment(d, q.projectId))
          .filter((d): d is VercelDeploymentInfo => d !== null),
        next: r.pagination?.next ?? null,
      };
    },
    async getDeployment(id) {
      return mapDeployment(
        await get(
          `/v13/deployments/${encodeURIComponent(id)}`,
          {},
          deploymentSchema,
          true,
        ),
      );
    },
  };
}

/** The deployment's page on vercel.com, built from stored ids only. */
export function vercelDeploymentUrl(
  teamSlug: string,
  projectName: string,
  deploymentId: string,
): string {
  return `https://vercel.com/${encodeURIComponent(teamSlug)}/${encodeURIComponent(projectName)}/${encodeURIComponent(deploymentId.replace(/^dpl_/, ""))}`;
}

export function vercelProjectUrl(
  teamSlug: string,
  projectName: string,
): string {
  return `https://vercel.com/${encodeURIComponent(teamSlug)}/${encodeURIComponent(projectName)}`;
}
