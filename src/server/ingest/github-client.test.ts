import { describe, expect, it } from "vitest";
import { Deadline, DeadlineReached, RateBudget } from "./budget";
import {
  GitHubTimeout,
  withBudget,
  withDeadline,
  type GitHubApi,
} from "./github-client";

/** A request that never answers until its signal aborts. */
const hung: GitHubApi = {
  request: (_route, params) =>
    new Promise((_resolve, reject) => {
      const signal = (params?.request as { signal?: AbortSignal } | undefined)
        ?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason));
    }),
};

describe("withDeadline", () => {
  it("aborts a hung request before the deadline and reports DeadlineReached", async () => {
    const started = Date.now();
    await expect(
      withDeadline(hung, new Deadline(Date.now() + 5_200)).request("GET /x"),
    ).rejects.toBeInstanceOf(DeadlineReached);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does not start a request inside the reserve", async () => {
    let called = false;
    const api: GitHubApi = {
      request: async <T>() => {
        called = true;
        return { status: 200, data: null as T, headers: {} };
      },
    };
    await expect(
      withDeadline(api, new Deadline(Date.now() + 1_000)).request("GET /x"),
    ).rejects.toBeInstanceOf(DeadlineReached);
    expect(called).toBe(false);
  });

  it("turns a per-request timeout with time left into a 504", async () => {
    const error = await withDeadline(
      hung,
      new Deadline(Date.now() + 60_000),
      50,
    )
      .request("GET /x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubTimeout);
    expect((error as GitHubTimeout).status).toBe(504);
  });

  it("keeps the caller's params and request options", async () => {
    let seen: Record<string, unknown> | undefined;
    const api: GitHubApi = {
      request: async <T>(_route: string, params?: Record<string, unknown>) => {
        seen = params;
        return { status: 200, data: null as T, headers: {} };
      },
    };
    await withBudget(
      api,
      new RateBudget(),
      new Deadline(Date.now() + 60_000),
    ).request("GET /x", { per_page: 100, request: { redirect: "manual" } });
    expect(seen?.per_page).toBe(100);
    expect(seen?.request).toMatchObject({ redirect: "manual" });
    expect((seen?.request as { signal?: unknown }).signal).toBeInstanceOf(
      AbortSignal,
    );
  });
});
