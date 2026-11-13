import { z } from "zod";

/**
 * Azure DevOps REST client (design addendum M7 §4.1). Pure: no database, no
 * logging, `fetch` injected, so every branch is unit-tested and the
 * integration tests run against an in-memory Azure DevOps
 * (test/integration/support/azure-devops.ts).
 *
 * - The host is pinned to `https://dev.azure.com/<org>`; the organisation is
 *   validated (`^[A-Za-z0-9][A-Za-z0-9-]{0,49}$`) and every path segment is
 *   URL-encoded. URLs are built from templates only: `_links`, `url` and
 *   `downloadUrl` values of responses are never followed (the schemas drop
 *   them). Redirects are not followed (`redirect: "manual"`).
 * - `api-version=7.1` unless a call names a preview version.
 * - 8 s timeout (or less: the caller's budget) and a 5 MB response cap.
 * - Rate-limit headers are read on every response, also on a 200:
 *   `Retry-After`, `X-RateLimit-Limit/-Remaining/-Reset/-Delay`. Any
 *   `Retry-After`, a remaining budget below 20 % of the limit, a 429 or
 *   `TF400733` stops the caller (the next request throws `rate_limited`).
 * - A hard cap of requests per client (80 per reconcile pass).
 * - Bad credentials: 401, 203 (Azure DevOps' sign-in page) or a non-JSON
 *   answer where JSON was expected count as `invalid_token`.
 * - Responses pass zod schemas that whitelist the fields the app stores;
 *   identities (`requestedFor`, `requestedBy`, `lastChangedBy`,
 *   `authenticatedUser`, pool `owner`/`createdBy`), e-mail addresses and
 *   every other field are dropped at this boundary.
 *
 * API facts (versions, paging, fields, the open probe items) are recorded
 * in docs/AZURE-DEVOPS.md.
 */

export const AZURE_ORIGIN = "https://dev.azure.com";
export const API_VERSION = "7.1";
/** Undocumented preview routes (verify, docs/AZURE-DEVOPS.md). */
export const JOB_REQUESTS_API_VERSION = "7.1-preview.1";
export const RESOURCE_USAGE_API_VERSION = "7.2-preview.1";
export const REQUEST_TIMEOUT_MS = 8_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const PAGE_TOP = 100;
/** Requests per reconcile pass (step z). */
export const PASS_REQUEST_CAP = 80;
/** Stop when fewer than 20 % of the rate budget (TSTU) are left. */
export const RATE_STOP_SHARE = 0.2;

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/;

/**
 * The organisation name from what an admin typed: the bare name,
 * `https://dev.azure.com/<org>[/…]` or the legacy `<org>.visualstudio.com`.
 * Null when it is not a valid organisation name.
 */
export function normalizeOrg(input: string): string | null {
  let v = input.trim();
  if (!v) return null;
  const legacy =
    /^(?:https?:\/\/)?([A-Za-z0-9-]+)\.visualstudio\.com(?:\/.*)?$/i.exec(v);
  if (legacy) v = legacy[1]!;
  else {
    const modern =
      /^(?:https?:\/\/)?dev\.azure\.com\/([^/?#]+)(?:[/?#].*)?$/i.exec(v);
    if (modern) v = decodeURIComponent(modern[1]!);
    else if (/[/:.]/.test(v)) return null;
  }
  return ORG.test(v) ? v : null;
}

export function isValidOrg(org: string): boolean {
  return ORG.test(org);
}

/** A PAT (Basic auth, empty user) or a Microsoft Entra access token (Bearer). */
export type AzureAuth =
  { kind: "basic"; pat: string } | { kind: "bearer"; token: string };

export function authHeader(auth: AzureAuth): string {
  return auth.kind === "basic"
    ? `Basic ${Buffer.from(`:${auth.pat}`, "utf8").toString("base64")}`
    : `Bearer ${auth.token}`;
}

export type AzureErrorCode =
  | "invalid_token"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "timeout"
  | "network"
  | "too_large"
  | "unexpected_response"
  | "request_cap"
  | "bad_request"
  | "conflict"
  | "http";

export class AzureError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: AzureErrorCode,
    message: string,
    /** The `ActivityId` response header (Azure DevOps' request id). */
    readonly activityId: string | null,
    readonly path: string,
    /** rate_limited: when calls may resume. */
    readonly retryAt: Date | null = null,
  ) {
    super(message);
    this.name = "AzureError";
  }

  /** The credential no longer works: 401, 203 or a sign-in page. */
  get revoked(): boolean {
    return this.code === "invalid_token";
  }

  get rateLimited(): boolean {
    return this.code === "rate_limited";
  }
}

/** What a response said about the rate budget (TSTUs). */
export type AzureRateInfo = {
  limit: number | null;
  remaining: number | null;
  resetAt: Date | null;
  /** Retry-After in seconds, also on a 200. */
  retryAfterS: number | null;
  delayS: number | null;
};

const num = (v: string | null) =>
  v == null || v.trim() === "" ? NaN : Number(v);

/** Reads the rate-limit headers of a response. */
export function rateInfoOf(headers: Headers, now: number): AzureRateInfo {
  const limit = num(headers.get("x-ratelimit-limit"));
  const remaining = num(headers.get("x-ratelimit-remaining"));
  const reset = num(headers.get("x-ratelimit-reset"));
  const retryAfter = num(headers.get("retry-after"));
  const delay = num(headers.get("x-ratelimit-delay"));
  return {
    limit: Number.isFinite(limit) ? limit : null,
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetAt: Number.isFinite(reset)
      ? new Date(reset * 1000)
      : Number.isFinite(retryAfter) && retryAfter > 0
        ? new Date(now + retryAfter * 1000)
        : null,
    retryAfterS:
      Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null,
    delayS: Number.isFinite(delay) ? delay : null,
  };
}

/**
 * When the caller must stop calling (step z ends, `pausedUntil` is set):
 * any Retry-After (also on a 200), or less than 20 % of the budget left.
 * Null when calls may go on.
 */
export function stopUntil(info: AzureRateInfo, now: number): Date | null {
  if (info.retryAfterS != null)
    return new Date(now + Math.max(1, info.retryAfterS) * 1000);
  if (
    info.limit != null &&
    info.limit > 0 &&
    info.remaining != null &&
    info.remaining < info.limit * RATE_STOP_SHARE
  )
    return info.resetAt && info.resetAt.getTime() > now
      ? info.resetAt
      : new Date(now + 5 * 60_000);
  return null;
}

// ---------- schemas (whitelists) ----------

const str = z.string().max(1000);
const guid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const date = z.string().max(64);

/** `{ count, value: [...] }`, the shape of every Azure DevOps list. */
export function listOf<T extends z.ZodType>(item: T) {
  return z.object({
    count: z.number().nullish(),
    value: z.array(item).max(5000),
  });
}

/** `GET /_apis/connectionData`: only the organisation (instance) id. */
export const connectionDataSchema = z.object({
  instanceId: guid.nullish(),
  locationServiceData: z.object({ serviceOwner: str.nullish() }).nullish(),
});

export const projectSchema = z.object({
  id: guid,
  name: str,
  visibility: str.nullish(),
  state: str.nullish(),
});

export const definitionSchema = z.object({
  id: z.number().int(),
  name: str,
  path: str.nullish(),
  queueStatus: str.nullish(),
  type: str.nullish(),
  project: z.object({ id: guid }).nullish(),
  repository: z
    .object({
      id: str.nullish(),
      name: str.nullish(),
      type: str.nullish(),
      defaultBranch: str.nullish(),
    })
    .nullish(),
  process: z
    .object({ type: z.number().nullish(), yamlFilename: str.nullish() })
    .nullish(),
});

/** triggerInfo: only the pull request fields (number, source SHA and branch). */
const triggerInfoSchema = z.record(z.string(), z.unknown()).transform((t) => ({
  prNumber: typeof t["pr.number"] === "string" ? t["pr.number"] : null,
  prSourceSha: typeof t["pr.sourceSha"] === "string" ? t["pr.sourceSha"] : null,
  prSourceBranch:
    typeof t["pr.sourceBranch"] === "string" ? t["pr.sourceBranch"] : null,
}));

export const buildSchema = z.object({
  id: z.number().int().positive(),
  buildNumber: str.nullish(),
  status: str.nullish(),
  result: str.nullish(),
  reason: str.nullish(),
  queueTime: date.nullish(),
  startTime: date.nullish(),
  finishTime: date.nullish(),
  lastChangedDate: date.nullish(),
  sourceBranch: str.nullish(),
  sourceVersion: str.nullish(),
  queuePosition: z.number().int().nullish(),
  definition: z.object({ id: z.number().int(), name: str.nullish() }).nullish(),
  project: z.object({ id: guid }).nullish(),
  repository: z.object({ id: str.nullish(), type: str.nullish() }).nullish(),
  triggerInfo: triggerInfoSchema.nullish(),
  tags: z.array(str).max(200).nullish(),
});

export const timelineRecordSchema = z.object({
  id: str,
  parentId: str.nullish(),
  type: str.nullish(),
  name: str.nullish(),
  identifier: str.nullish(),
  state: str.nullish(),
  result: str.nullish(),
  startTime: date.nullish(),
  finishTime: date.nullish(),
  attempt: z.number().int().nullish(),
  order: z.number().nullish(),
  workerName: str.nullish(),
  queueId: z.number().int().nullish(),
  log: z.object({ id: z.number().int() }).nullish(),
  previousAttempts: z
    .array(
      z.object({
        attempt: z.number().int(),
        timelineId: str.nullish(),
        recordId: str.nullish(),
      }),
    )
    .max(50)
    .nullish(),
  /** Read for the job-cap rule only; never stored. */
  issues: z
    .array(
      z.object({
        type: str.nullish(),
        message: z.string().max(4000).nullish(),
      }),
    )
    .max(200)
    .nullish(),
});

export const timelineSchema = z.object({
  id: str.nullish(),
  changeId: z.number().int().nullish(),
  records: z.array(timelineRecordSchema).max(5000).nullish(),
});

export const poolSchema = z.object({
  id: z.number().int(),
  name: str,
  isHosted: z.boolean().nullish(),
  poolType: str.nullish(),
  size: z.number().int().nullish(),
});

/** A job request; owner and definition keep their ids only. */
export const jobRequestSchema = z.object({
  requestId: z.number().int(),
  poolId: z.number().int().nullish(),
  queueTime: date.nullish(),
  assignTime: date.nullish(),
  receiveTime: date.nullish(),
  finishTime: date.nullish(),
  result: str.nullish(),
  jobId: str.nullish(),
  scopeId: str.nullish(),
  planType: str.nullish(),
  owner: z.object({ id: z.number().int().nullish() }).nullish(),
  definition: z.object({ id: z.number().int().nullish() }).nullish(),
  agentSpecification: z
    .record(z.string(), z.unknown())
    .transform((s) => ({
      image:
        typeof s.VMImage === "string"
          ? s.VMImage
          : typeof s.vmImage === "string"
            ? s.vmImage
            : null,
    }))
    .nullish(),
});

export const agentSchema = z.object({
  id: z.number().int(),
  name: str,
  status: str.nullish(),
  enabled: z.boolean().nullish(),
  version: str.nullish(),
  osDescription: str.nullish(),
  statusChangedOn: date.nullish(),
  assignedRequest: jobRequestSchema.nullish(),
});

/** resourceusage (preview, verify): tolerant, missing fields are null. */
export const resourceUsageSchema = z.object({
  resourceLimit: z
    .object({
      totalMinutes: z.number().nullish(),
      totalCount: z.number().nullish(),
      isPremium: z.boolean().nullish(),
      isHosted: z.boolean().nullish(),
      parallelismTag: str.nullish(),
    })
    .nullish(),
  usedCount: z.number().nullish(),
  usedMinutes: z.number().nullish(),
});

export const hookSubscriptionSchema = z.object({
  id: str,
  eventType: str.nullish(),
  status: str.nullish(),
  publisherInputs: z.object({ projectId: str.nullish() }).nullish(),
  consumerInputs: z.object({ url: str.nullish() }).nullish(),
});

export type AzureProjectInfo = {
  id: string;
  name: string;
  visibility: "private" | "public";
};

export type AzureDefinitionInfo = {
  id: number;
  projectId: string;
  name: string;
  path: string | null;
  yamlPath: string | null;
  repoType: string;
  /** "owner/name" of a GitHub repository. */
  repoFullName: string | null;
  defaultBranch: string | null;
  queueStatus: string | null;
};

export type AzureBuildRaw = z.infer<typeof buildSchema>;
export type AzureTimelineRecord = z.infer<typeof timelineRecordSchema>;
export type AzureTimeline = {
  id: string | null;
  changeId: number | null;
  records: AzureTimelineRecord[];
};
export type AzurePoolInfo = {
  id: number;
  name: string;
  isHosted: boolean;
  poolType: string;
  size: number | null;
};
export type AzureJobRequestInfo = {
  requestId: bigint;
  poolId: number;
  queueTime: Date | null;
  assignTime: Date | null;
  finishTime: Date | null;
  result: string | null;
  jobId: string | null;
  projectId: string | null;
  buildId: number | null;
  image: string | null;
};
export type AzureAgentInfo = {
  id: number;
  name: string;
  status: string;
  enabled: boolean;
  version: string | null;
  osDescription: string | null;
  statusChangedAt: Date | null;
  busy: boolean;
  assigned: AzureJobRequestInfo | null;
};
export type AzureResourceUsage = {
  totalMinutes: number | null;
  totalCount: number | null;
  isPremium: boolean | null;
  usedCount: number | null;
  usedMinutes: number | null;
};
export type AzureHookSubscriptionInfo = {
  id: string;
  eventType: string;
  status: string;
  projectId: string | null;
  url: string | null;
};

// ---------- mappers (pure, exported for tests) ----------

export function toDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const t = Date.parse(v);
  // Azure DevOps sends 0001-01-01 for "not set".
  if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1)) return null;
  return new Date(t);
}

export function mapProject(p: z.infer<typeof projectSchema>): AzureProjectInfo {
  return {
    id: p.id.toLowerCase(),
    name: p.name.slice(0, 200),
    visibility: p.visibility === "public" ? "public" : "private",
  };
}

/** "owner/name" of a GitHub repository reference, or null. */
export function githubRepoOf(
  repo:
    | { id?: string | null; name?: string | null; type?: string | null }
    | null
    | undefined,
): string | null {
  if (!repo || (repo.type ?? "").toLowerCase() !== "github") return null;
  for (const v of [repo.name, repo.id]) {
    if (v && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(v)) return v;
  }
  return null;
}

export function mapDefinition(
  d: z.infer<typeof definitionSchema>,
  projectId: string,
): AzureDefinitionInfo {
  return {
    id: d.id,
    projectId: (d.project?.id ?? projectId).toLowerCase(),
    name: d.name.slice(0, 200),
    path: d.path ? d.path.slice(0, 400) : null,
    yamlPath: d.process?.yamlFilename
      ? d.process.yamlFilename.slice(0, 400)
      : null,
    repoType: (d.repository?.type ?? "unknown").slice(0, 40),
    repoFullName: githubRepoOf(d.repository),
    defaultBranch: d.repository?.defaultBranch
      ? d.repository.defaultBranch.replace(/^refs\/heads\//, "").slice(0, 255)
      : null,
    queueStatus: d.queueStatus ?? null,
  };
}

export function mapPool(p: z.infer<typeof poolSchema>): AzurePoolInfo {
  return {
    id: p.id,
    name: p.name.slice(0, 200),
    isHosted: p.isHosted === true,
    poolType: p.poolType ?? "automation",
    size: p.size ?? null,
  };
}

export function mapJobRequest(
  r: z.infer<typeof jobRequestSchema>,
  poolId: number,
): AzureJobRequestInfo {
  return {
    requestId: BigInt(r.requestId),
    poolId: r.poolId ?? poolId,
    queueTime: toDate(r.queueTime),
    assignTime: toDate(r.assignTime),
    finishTime: toDate(r.finishTime),
    result: r.result ?? null,
    jobId: r.jobId ? r.jobId.toLowerCase() : null,
    projectId:
      r.scopeId && guid.safeParse(r.scopeId).success
        ? r.scopeId.toLowerCase()
        : null,
    buildId: r.owner?.id ?? null,
    image: r.agentSpecification?.image
      ? r.agentSpecification.image.slice(0, 80)
      : null,
  };
}

export function mapAgent(
  a: z.infer<typeof agentSchema>,
  poolId: number,
): AzureAgentInfo {
  return {
    id: a.id,
    name: a.name.slice(0, 200),
    status: a.status === "online" ? "online" : "offline",
    enabled: a.enabled !== false,
    version: a.version ?? null,
    osDescription: a.osDescription ? a.osDescription.slice(0, 200) : null,
    statusChangedAt: toDate(a.statusChangedOn),
    busy: !!a.assignedRequest,
    assigned: a.assignedRequest
      ? mapJobRequest(a.assignedRequest, poolId)
      : null,
  };
}

// ---------- transport ----------

export type Query = Record<
  string,
  string | number | boolean | undefined | null
>;

export type AzureClientOptions = {
  org: string;
  auth: AzureAuth;
  fetch?: Fetch;
  /** Per request; a function lets the caller bound it by a deadline. */
  timeoutMs?: number | (() => number);
  /** Runs before every request; may throw (a deadline check). */
  beforeRequest?: () => void;
  now?: () => number;
  /** Called with the rate-limit headers of every response. */
  onRate?: (info: AzureRateInfo) => void;
  /** Called with the activity id of every response. */
  onActivityId?: (id: string | null) => void;
  /** Hard cap of requests of this client (default: none). */
  maxRequests?: number;
};

export type AzureMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type AzureRequest<T> = {
  method: AzureMethod;
  /** Path below the organisation, e.g. "/_apis/projects". Segments must already be encoded. */
  path: string;
  query?: Query;
  schema: z.ZodType<T>;
  body?: unknown;
  /** Default "7.1"; null sends no api-version. */
  apiVersion?: string | null;
  maxBytes?: number;
  /** Return the body as text (build logs). */
  text?: boolean;
};

export type AzureResponse<T> = {
  data: T;
  status: number;
  activityId: string | null;
  continuation: string | null;
};

/** The request URL: the pinned origin, the validated org, the path and the query. */
export function azureUrl(
  org: string,
  path: string,
  query: Query = {},
  apiVersion: string | null = API_VERSION,
): URL {
  if (!ORG.test(org)) throw new Error("invalid Azure DevOps organisation");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes(".."))
    throw new Error(
      "Azure DevOps paths are absolute and relative to the organisation",
    );
  const url = new URL(`${AZURE_ORIGIN}/${encodeURIComponent(org)}${path}`);
  if (url.origin !== AZURE_ORIGIN) throw new Error("dev.azure.com only");
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  if (apiVersion) url.searchParams.set("api-version", apiVersion);
  return url;
}

/** One encoded path segment (project id, definition id, …). */
export function seg(value: string | number): string {
  const s = String(value);
  if (!s || s.length > 200 || s.includes("/") || s.includes("\\"))
    throw new Error("invalid Azure DevOps path segment");
  return encodeURIComponent(s);
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

/** A transport with its request counter and stop flag. */
export type AzureTransport = {
  request<T>(req: AzureRequest<T>): Promise<AzureResponse<T>>;
  /** Requests sent so far. */
  readonly requests: number;
  /** Set once a response asked to stop (Retry-After, low headroom). */
  readonly stoppedUntil: Date | null;
};

/**
 * The stored form of an Azure DevOps error body: its free text often names
 * the identity ("<display name> needs … permissions", "The user '<upn>' is
 * not authorized"), so only the HTTP status, the leading TFxxxxx/VSxxxxx key
 * and the exception type key are kept.
 */
export function safeAzureMessage(
  status: number,
  message: unknown,
  typeKey?: unknown,
): string {
  const parts: string[] = [];
  const key =
    typeof message === "string"
      ? /^\s*((?:TF|VS)\d{5,6})\b/.exec(message)
      : null;
  if (key) parts.push(key[1]!);
  if (
    typeof typeKey === "string" &&
    /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(typeKey)
  )
    parts.push(typeKey);
  parts.push(`HTTP ${status}`);
  return parts.join(" ");
}

export function createAzureTransport(opts: AzureClientOptions): AzureTransport {
  const doFetch: Fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  let requests = 0;
  let stoppedUntil: Date | null = null;

  async function request<T>(req: AzureRequest<T>): Promise<AzureResponse<T>> {
    const { path } = req;
    if (stoppedUntil)
      throw new AzureError(
        null,
        "rate_limited",
        "Azure DevOps asked to slow down",
        null,
        path,
        stoppedUntil,
      );
    if (opts.maxRequests != null && requests >= opts.maxRequests)
      throw new AzureError(
        null,
        "request_cap",
        "request cap of the pass reached",
        null,
        path,
      );
    const url = azureUrl(
      opts.org,
      path,
      req.query,
      req.apiVersion === undefined ? API_VERSION : req.apiVersion,
    );
    opts.beforeRequest?.();
    requests++;
    const timeout =
      typeof opts.timeoutMs === "function"
        ? opts.timeoutMs()
        : (opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.timeout(
      Math.max(1, Math.min(REQUEST_TIMEOUT_MS, timeout)),
    );
    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method: req.method,
        headers: {
          authorization: authHeader(opts.auth),
          accept: req.text ? "text/plain" : "application/json",
          // Answer 401 instead of redirecting to the sign-in page.
          "x-tfs-fedauthredirect": "Suppress",
          ...(req.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        signal,
        redirect: "manual",
        cache: "no-store",
      });
    } catch (error) {
      if (signal.aborted)
        throw new AzureError(
          504,
          "timeout",
          "Azure DevOps request timed out",
          null,
          path,
        );
      throw new AzureError(
        null,
        "network",
        error instanceof Error ? error.message : "network error",
        null,
        path,
      );
    }
    const activityId =
      res.headers.get("activityid") ?? res.headers.get("x-vss-e2eid") ?? null;
    opts.onActivityId?.(activityId);
    const rate = rateInfoOf(res.headers, now());
    opts.onRate?.(rate);
    const stop = stopUntil(rate, now());
    if (stop) stoppedUntil = stop;

    // A redirect (sign-in), 203 (sign-in page as 200 with HTML) or 401.
    if (
      res.status === 401 ||
      res.status === 203 ||
      (res.status >= 300 && res.status < 400) ||
      res.type === "opaqueredirect"
    ) {
      await res.body?.cancel().catch(() => undefined);
      throw new AzureError(
        res.status || 401,
        "invalid_token",
        "Azure DevOps rejected the credential",
        activityId,
        path,
      );
    }
    const maxBytes = req.maxBytes ?? MAX_RESPONSE_BYTES;
    const text = await readCapped(res, maxBytes);
    if (text === null)
      throw new AzureError(
        res.status,
        "too_large",
        `Azure DevOps response larger than ${Math.round(maxBytes / 1024)} KB`,
        activityId,
        path,
      );
    const contentType = res.headers.get("content-type") ?? "";
    let body: unknown = null;
    let parsedJson = false;
    try {
      body = text ? JSON.parse(text) : null;
      parsedJson = true;
    } catch {
      body = null;
    }
    const rawMessage = (body as { message?: unknown } | null)?.message;
    const message = safeAzureMessage(
      res.status,
      rawMessage,
      (body as { typeKey?: unknown } | null)?.typeKey,
    );
    if (
      res.status === 429 ||
      (typeof rawMessage === "string" && /TF400733/.test(rawMessage))
    ) {
      const retryAt =
        stop ?? new Date(now() + Math.max(60, rate.retryAfterS ?? 60) * 1000);
      stoppedUntil = retryAt;
      throw new AzureError(
        429,
        "rate_limited",
        message,
        activityId,
        path,
        retryAt,
      );
    }
    if (!res.ok) {
      const code: AzureErrorCode =
        res.status === 403
          ? "forbidden"
          : res.status === 404
            ? "not_found"
            : res.status === 400
              ? "bad_request"
              : res.status === 409
                ? "conflict"
                : "http";
      throw new AzureError(res.status, code, message, activityId, path);
    }
    if (req.text) {
      const parsed = req.schema.safeParse(text);
      if (!parsed.success)
        throw new AzureError(
          res.status,
          "unexpected_response",
          "Unexpected response from Azure DevOps",
          activityId,
          path,
        );
      return {
        data: parsed.data,
        status: res.status,
        activityId,
        continuation: res.headers.get("x-ms-continuationtoken"),
      };
    }
    // HTML where JSON was expected: the sign-in page.
    if (text && (!parsedJson || /text\/html/i.test(contentType)))
      throw new AzureError(
        res.status,
        "invalid_token",
        "Azure DevOps answered with a sign-in page",
        activityId,
        path,
      );
    const parsed = req.schema.safeParse(body);
    if (!parsed.success)
      throw new AzureError(
        res.status,
        "unexpected_response",
        "Unexpected response from Azure DevOps",
        activityId,
        path,
      );
    return {
      data: parsed.data,
      status: res.status,
      activityId,
      continuation: res.headers.get("x-ms-continuationtoken"),
    };
  }

  return {
    request,
    get requests() {
      return requests;
    },
    get stoppedUntil() {
      return stoppedUntil;
    },
  };
}

// ---------- read client ----------

export type BuildQuery = {
  minTime?: Date | null;
  maxTime?: Date | null;
  queryOrder?:
    | "queueTimeAscending"
    | "queueTimeDescending"
    | "finishTimeDescending"
    | "finishTimeAscending";
  statusFilter?: "completed" | "inProgress" | "notStarted" | "all";
  buildIds?: ReadonlyArray<number>;
  definitions?: ReadonlyArray<number>;
  top?: number;
  continuation?: string | null;
};

export interface AzureReadApi {
  readonly transport: AzureTransport;
  /** The organisation id; null when connectionData is not available. */
  connectionData(): Promise<{ orgId: string | null }>;
  listProjects(continuation?: string | null): Promise<{
    projects: AzureProjectInfo[];
    continuation: string | null;
  }>;
  listDefinitions(
    projectId: string,
    continuation?: string | null,
  ): Promise<{
    definitions: AzureDefinitionInfo[];
    continuation: string | null;
  }>;
  listBuilds(
    projectId: string,
    q: BuildQuery,
  ): Promise<{ builds: AzureBuildRaw[]; continuation: string | null }>;
  getTimeline(
    projectId: string,
    buildId: number,
    timelineId?: string | null,
  ): Promise<AzureTimeline | null>;
  listPools(): Promise<AzurePoolInfo[]>;
  listAgents(poolId: number): Promise<AzureAgentInfo[]>;
  listJobRequests(poolId: number, top?: number): Promise<AzureJobRequestInfo[]>;
  /** Null when the preview route is unavailable or its shape changed. */
  getResourceUsage(): Promise<AzureResourceUsage | null>;
  listHookSubscriptions(): Promise<AzureHookSubscriptionInfo[]>;
  /**
   * The newest lines of one log (raw; callers sanitise): reads the log's
   * line count first and requests only the last `lines` lines, so a log of
   * any size gives its tail. `earlier` tells that older lines were left out.
   */
  getLog(
    projectId: string,
    buildId: number,
    logId: number,
    lines?: number,
  ): Promise<{ text: string; earlier: boolean }>;
}

const buildLogSchema = z.object({
  id: z.number().int(),
  lineCount: z.number().int().nonnegative().nullish(),
});

const iso = (d: Date) => d.toISOString();
export const LOG_MAX_BYTES = 1024 * 1024;

export function createAzureClient(opts: AzureClientOptions): AzureReadApi {
  const transport = createAzureTransport(opts);
  const get = async <T>(
    path: string,
    query: Query,
    schema: z.ZodType<T>,
    apiVersion?: string | null,
  ) => transport.request({ method: "GET", path, query, schema, apiVersion });

  return {
    transport,
    async connectionData() {
      const r = await get(
        "/_apis/connectionData",
        {},
        connectionDataSchema,
        null,
      );
      return {
        orgId: r.data.instanceId ? r.data.instanceId.toLowerCase() : null,
      };
    },
    async listProjects(continuation) {
      const r = await get(
        "/_apis/projects",
        { $top: PAGE_TOP, continuationToken: continuation ?? undefined },
        listOf(projectSchema),
      );
      return {
        projects: r.data.value
          .filter((p) => !p.state || p.state === "wellFormed")
          .map(mapProject),
        continuation: r.continuation,
      };
    },
    async listDefinitions(projectId, continuation) {
      const r = await get(
        `/${seg(projectId)}/_apis/build/definitions`,
        {
          includeAllProperties: true,
          $top: PAGE_TOP,
          continuationToken: continuation ?? undefined,
        },
        listOf(definitionSchema),
      );
      return {
        definitions: r.data.value.map((d) => mapDefinition(d, projectId)),
        continuation: r.continuation,
      };
    },
    async listBuilds(projectId, q) {
      const r = await get(
        `/${seg(projectId)}/_apis/build/builds`,
        {
          minTime: q.minTime ? iso(q.minTime) : undefined,
          maxTime: q.maxTime ? iso(q.maxTime) : undefined,
          queryOrder: q.queryOrder,
          statusFilter: q.statusFilter,
          buildIds: q.buildIds?.length
            ? q.buildIds.slice(0, 100).join(",")
            : undefined,
          definitions: q.definitions?.length
            ? q.definitions.slice(0, 100).join(",")
            : undefined,
          $top: q.top ?? PAGE_TOP,
          continuationToken: q.continuation ?? undefined,
        },
        listOf(buildSchema),
      );
      return { builds: r.data.value, continuation: r.continuation };
    },
    async getTimeline(projectId, buildId, timelineId) {
      try {
        const r = await get(
          `/${seg(projectId)}/_apis/build/builds/${seg(buildId)}/timeline${timelineId ? `/${seg(timelineId)}` : ""}`,
          {},
          timelineSchema.nullable(),
        );
        if (!r.data) return null;
        return {
          id: r.data.id ?? null,
          changeId: r.data.changeId ?? null,
          records: r.data.records ?? [],
        };
      } catch (error) {
        if (error instanceof AzureError && error.code === "not_found")
          return null;
        throw error;
      }
    },
    async listPools() {
      const r = await get(
        "/_apis/distributedtask/pools",
        {},
        listOf(poolSchema),
      );
      return r.data.value.map(mapPool);
    },
    async listAgents(poolId) {
      const r = await get(
        `/_apis/distributedtask/pools/${seg(poolId)}/agents`,
        { includeAssignedRequest: true },
        listOf(agentSchema),
      );
      return r.data.value.map((a) => mapAgent(a, poolId));
    },
    async listJobRequests(poolId, top = 200) {
      const r = await get(
        `/_apis/distributedtask/pools/${seg(poolId)}/jobrequests`,
        { $top: top },
        listOf(jobRequestSchema),
        JOB_REQUESTS_API_VERSION,
      );
      return r.data.value.map((x) => mapJobRequest(x, poolId));
    },
    async getResourceUsage() {
      try {
        const r = await get(
          "/_apis/distributedtask/resourceusage",
          {
            parallelismTag: "Private",
            poolIsHosted: true,
            includeRunningRequests: false,
          },
          resourceUsageSchema,
          RESOURCE_USAGE_API_VERSION,
        );
        const l = r.data.resourceLimit ?? {};
        return {
          totalMinutes: l.totalMinutes ?? null,
          totalCount: l.totalCount ?? null,
          isPremium: l.isPremium ?? null,
          usedCount: r.data.usedCount ?? null,
          usedMinutes: r.data.usedMinutes ?? null,
        };
      } catch (error) {
        if (
          error instanceof AzureError &&
          (error.code === "not_found" ||
            error.code === "unexpected_response" ||
            error.code === "bad_request" ||
            error.code === "forbidden")
        )
          return null;
        throw error;
      }
    },
    async listHookSubscriptions() {
      const r = await get(
        "/_apis/hooks/subscriptions",
        {},
        listOf(hookSubscriptionSchema),
      );
      return r.data.value.map((s) => ({
        id: s.id,
        eventType: s.eventType ?? "",
        status: s.status ?? "unknown",
        projectId: s.publisherInputs?.projectId ?? null,
        url: s.consumerInputs?.url ?? null,
      }));
    },
    async getLog(projectId, buildId, logId, lines = 200) {
      const base = `/${seg(projectId)}/_apis/build/builds/${seg(buildId)}/logs`;
      let lineCount: number | null = null;
      try {
        const list = await get(base, {}, listOf(buildLogSchema));
        lineCount =
          list.data.value.find((l) => l.id === logId)?.lineCount ?? null;
      } catch (error) {
        // Without the line count the whole log is read (up to the cap).
        if (!(
          error instanceof AzureError &&
          (error.code === "not_found" ||
            error.code === "unexpected_response" ||
            error.code === "bad_request")
        ))
          throw error;
      }
      const earlier = lineCount != null && lineCount > lines;
      const r = await transport.request({
        method: "GET",
        path: `${base}/${seg(logId)}`,
        query: earlier
          ? { startLine: lineCount! - lines + 1, endLine: lineCount! }
          : {},
        schema: z.string(),
        text: true,
        maxBytes: LOG_MAX_BYTES,
      });
      return { text: r.data, earlier };
    },
  };
}

/** The build's page in Azure DevOps, built from stored ids only. */
export function azureBuildUrl(
  org: string,
  projectId: string,
  buildId: number,
): string {
  return `${AZURE_ORIGIN}/${encodeURIComponent(org)}/${encodeURIComponent(projectId)}/_build/results?buildId=${buildId}`;
}

export function azureDefinitionUrl(
  org: string,
  projectId: string,
  definitionId: number,
): string {
  return `${AZURE_ORIGIN}/${encodeURIComponent(org)}/${encodeURIComponent(projectId)}/_build?definitionId=${definitionId}`;
}

export function azureOrgUrl(org: string): string {
  return `${AZURE_ORIGIN}/${encodeURIComponent(org)}`;
}
