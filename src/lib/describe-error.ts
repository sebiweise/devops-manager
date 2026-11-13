import { redactError } from "@/server/ingest/webhook";

/**
 * One log line for a failed call: the error name plus, for Octokit's
 * HttpError, the status, method, path and GitHub's message, and for a
 * VercelError the status, code, path and the `x-vercel-id`. Tokens
 * (GitHub and Vercel) are redacted and the query string is dropped, so the
 * line is safe to log.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const e = error as Error & {
    status?: number;
    request?: { method?: string; url?: string };
    path?: unknown;
    code?: unknown;
    requestId?: unknown;
  };
  const parts = [e.name];
  if (typeof e.status === "number") parts.push(String(e.status));
  if (e.request?.url) {
    const path = e.request.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    parts.push(`${e.request.method ?? "GET"} ${path}`);
  }
  if (e.name === "VercelError" || e.name === "VercelTimeout") {
    if (typeof e.code === "string") parts.push(e.code);
    if (typeof e.path === "string") parts.push(`GET ${e.path.split("?")[0]}`);
    if (typeof e.requestId === "string")
      parts.push(`x-vercel-id ${e.requestId.slice(0, 80)}`);
  }
  if (e.message) parts.push(redactError(e.message, 300));
  return parts.join(" · ");
}
