import type { TokenPurpose } from "@/server/github/purposes";
import type { RateBudget } from "./budget";

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

/** Feeds every response's rate-limit headers into `budget`. */
export function withBudget(api: GitHubApi, budget: RateBudget): GitHubApi {
  return {
    async request<T>(route: string, params?: Record<string, unknown>) {
      try {
        const res = await api.request<T>(route, params);
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
