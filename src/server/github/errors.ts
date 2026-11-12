/**
 * GitHub error details for the audit log and the UI (design §8.1 step 9):
 * the HTTP status, GitHub's message verbatim and the `x-github-request-id`.
 * Works with Octokit's RequestError and with any error of the same shape.
 * Pure.
 */

export type GitHubErrorInfo = {
  status: number | null;
  message: string;
  requestId: string | null;
};

type Shape = {
  status?: unknown;
  message?: unknown;
  response?: { data?: unknown; headers?: Record<string, unknown> };
};

export function githubErrorInfo(error: unknown): GitHubErrorInfo {
  if (typeof error !== "object" || error === null)
    return { status: null, message: "Unknown error", requestId: null };
  const e = error as Shape;
  const status = typeof e.status === "number" ? e.status : null;
  const data = e.response?.data;
  const fromBody =
    typeof data === "object" &&
    data !== null &&
    typeof (data as { message?: unknown }).message === "string"
      ? (data as { message: string }).message
      : null;
  const message =
    fromBody ??
    (typeof e.message === "string" && e.message ? e.message : "Unknown error");
  const header = e.response?.headers?.["x-github-request-id"];
  return {
    status,
    message,
    requestId: typeof header === "string" ? header : null,
  };
}

/** The request id of a successful response, if GitHub sent one. */
export function requestIdOf(
  headers: Record<string, string | number | undefined> | undefined,
): string | null {
  const id = headers?.["x-github-request-id"];
  return typeof id === "string" ? id : null;
}
