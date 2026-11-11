import type { TokenPurpose } from "@/server/github/purposes";
import { DeadlineReached, type Deadline, type RateBudget } from "./budget";

/**
 * The slice of Octokit that sync, backfill and reconcile use. Production code
 * passes Octokit instances from the token broker (src/server/github/app.ts);
 * tests pass an in-memory fake, so reconcile is tested without network.
 */

export type GhResponse<T = unknown> = {
  status: number;
  data: T;
  headers: Record<string, string | number | undefined>;
};

export interface GitHubApi {
  request<T = unknown>(
    route: string,
    params?: Record<string, unknown>,
  ): Promise<GhResponse<T>>;
}

export type GitHubClients = {
  /** Authenticated as the App (JWT): hook deliveries, installations. */
  app(): GitHubApi;
  /** Installation token for one purpose (token broker). */
  installation(
    installationId: bigint,
    purpose: TokenPurpose,
    granted: Record<string, unknown>,
    repoIds?: ReadonlyArray<bigint>,
  ): Promise<GitHubApi>;
};

export function errorStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === "number" ? status : null;
  }
  return null;
}

function errorHeaders(
  error: unknown,
): Record<string, string | number | undefined> | undefined {
  if (typeof error === "object" && error !== null && "response" in error) {
    const response = (error as { response?: { headers?: unknown } }).response;
    if (response && typeof response.headers === "object")
      return response.headers as Record<string, string | number | undefined>;
  }
  return undefined;
}

/** Upper bound for one GitHub request inside reconcile. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Time kept free after a request so its result can still be persisted. */
const REQUEST_RESERVE_MS = 5_000;

/** A request aborted by its timeout while the deadline still had room. */
export class GitHubTimeout extends Error {
  readonly status = 504;
  constructor() {
    super("GitHub request timed out");
    this.name = "GitHubTimeout";
  }
}

/**
 * Bounds every request by the deadline: each call gets an AbortSignal of
 * min(20 s, remaining - 5 s), so one slow or hung request cannot run past
 * the function limit. An abort near the deadline becomes DeadlineReached,
 * an earlier one a GitHubTimeout (status 504, handled like any failure).
 */
export function withDeadline(
  api: GitHubApi,
  deadline: Deadline,
  requestTimeoutMs: number = REQUEST_TIMEOUT_MS,
): GitHubApi {
  return {
    async request<T>(route: string, params?: Record<string, unknown>) {
      const timeoutMs = Math.min(
        requestTimeoutMs,
        deadline.remainingMs() - REQUEST_RESERVE_MS,
      );
      if (timeoutMs <= 0) throw new DeadlineReached();
      const signal = AbortSignal.timeout(timeoutMs);
      const request = {
        ...((params?.request as Record<string, unknown> | undefined) ?? {}),
        signal,
      };
      try {
        return await api.request<T>(route, { ...params, request });
      } catch (error) {
        if (!signal.aborted) throw error;
        if (deadline.expired(REQUEST_RESERVE_MS)) throw new DeadlineReached();
        throw new GitHubTimeout();
      }
    },
  };
}

/**
 * Feeds every response's rate-limit headers into `budget`; with a deadline,
 * every request is also bounded by it (see `withDeadline`).
 */
export function withBudget(
  api: GitHubApi,
  budget: RateBudget,
  deadline?: Deadline,
): GitHubApi {
  const inner = deadline ? withDeadline(api, deadline) : api;
  return {
    async request<T>(route: string, params?: Record<string, unknown>) {
      try {
        const res = await inner.request<T>(route, params);
        budget.observe(res.headers, res.status);
        return res;
      } catch (error) {
        budget.observe(errorHeaders(error), errorStatus(error) ?? undefined);
        throw error;
      }
    },
  };
}

/** Next-page URL from a Link header. */
export function nextLink(
  headers: Record<string, string | number | undefined>,
): string | null {
  const link = headers.link;
  if (typeof link !== "string") return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1]!;
  }
  return null;
}

/** Pages of a list endpoint, following Link headers, until `stop` returns true. */
export async function* pages<T>(
  api: GitHubApi,
  route: string,
  params: Record<string, unknown>,
): AsyncGenerator<GhResponse<T>> {
  let res = await api.request<T>(route, params);
  yield res;
  for (let i = 0; i < 100; i++) {
    const next = nextLink(res.headers);
    if (!next) return;
    res = await api.request<T>(`GET ${next}`);
    yield res;
  }
}
