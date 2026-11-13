import { scrubKnown } from "@/server/ingest/webhook";
import type { VercelLogLine } from "./client";

/**
 * The build log excerpt (design addendum §8.2, D8): the newest 200 lines of
 * a deployment's build output, fetched live for operators and admins,
 * sanitised and never stored or logged. Pure, so the scrubbing is tested.
 *
 * - The exact token of the call and every known token pattern (GitHub,
 *   Vercel, `Bearer …`, `token=…`) become "[redacted]" (scrubKnown).
 * - ANSI escape sequences and control characters are removed; the excerpt
 *   is rendered as plain text.
 * - At most 2000 characters per line and 256 KB in total (older lines are
 *   dropped first).
 */

export const LOG_LINE_MAX = 2000;
export const LOG_TOTAL_MAX_BYTES = 256 * 1024;

export type LogExcerptLine = {
  at: string | null;
  stream: "out" | "err" | "cmd";
  text: string;
};

export type LogExcerpt = {
  lines: LogExcerptLine[];
  /** Older lines were dropped by the size cap. */
  truncated: boolean;
};

const ANSI =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function sanitizeLogLine(
  text: string,
  secrets: ReadonlyArray<string | null | undefined>,
): string {
  const plain = text
    .replace(ANSI, "")
    .replace(CONTROL, "")
    .replace(/\t/g, "  ");
  return scrubKnown(plain, secrets, LOG_LINE_MAX);
}

export function buildLogExcerpt(
  lines: ReadonlyArray<VercelLogLine>,
  secrets: ReadonlyArray<string | null | undefined>,
): LogExcerpt {
  const out: LogExcerptLine[] = [];
  let bytes = 0;
  let truncated = false;
  outer: for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    for (const part of l.text.split(/\r?\n/).reverse()) {
      const text = sanitizeLogLine(part, secrets);
      const size = Buffer.byteLength(text, "utf8") + 1;
      if (bytes + size > LOG_TOTAL_MAX_BYTES) {
        truncated = true;
        break outer;
      }
      bytes += size;
      out.push({
        at: l.at ? l.at.toISOString() : null,
        stream:
          l.type === "stderr" || l.type === "fatal"
            ? "err"
            : l.type === "command"
              ? "cmd"
              : "out",
        text,
      });
    }
  }
  out.reverse();
  // Trailing empty lines carry nothing.
  while (out.length > 0 && out[out.length - 1]!.text.trim() === "") out.pop();
  return { lines: out, truncated };
}
