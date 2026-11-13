import { redactError } from "@/server/ingest/webhook";

/**
 * One log line for a failed call: the error name plus, for Octokit's
 * HttpError, the status, method, path and GitHub's message. Tokens are
 * redacted and the query string is dropped, so the line is safe to log.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const e = error as Error & {
    status?: number;
    request?: { method?: string; url?: string };
  };
  const parts = [e.name];
  if (typeof e.status === "number") parts.push(String(e.status));
  if (e.request?.url) {
    const path = e.request.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    parts.push(`${e.request.method ?? "GET"} ${path}`);
  }
  if (e.message) parts.push(redactError(e.message, 300));
  return parts.join(" · ");
}
