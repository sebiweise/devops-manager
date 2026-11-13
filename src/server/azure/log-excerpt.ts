import { sanitizeLogLine } from "@/server/vercel/log-excerpt";

/**
 * The job log excerpt of an Azure Pipelines run (design addendum M7 §6
 * "Run detail"): the newest 200 lines of one job's log, fetched live for
 * operators and admins, sanitised and never stored or logged. Pure, so the
 * scrubbing is tested.
 *
 * - The credential of the call, the organisation and project names and
 *   every known token pattern become "[redacted]" (scrubKnown via
 *   sanitizeLogLine); ANSI escapes and control characters are removed.
 * - At most 200 lines and 64 KB (older lines are dropped first).
 * - Azure DevOps prefixes every line with an ISO timestamp; it becomes `at`.
 */

export const AZURE_LOG_LINES = 200;
export const AZURE_LOG_MAX_BYTES = 64 * 1024;

export type AzureLogLine = {
  at: string | null;
  stream: "out" | "err" | "cmd";
  text: string;
};

export type AzureLogExcerpt = { lines: AzureLogLine[]; truncated: boolean };

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?/;

export function buildAzureLogExcerpt(
  raw: string,
  secrets: ReadonlyArray<string | null | undefined>,
  /** Older lines were not fetched (a line range of a long log). */
  earlier = false,
): AzureLogExcerpt {
  const all = raw.split(/\r?\n/);
  while (all.length > 0 && all[all.length - 1]!.trim() === "") all.pop();
  const tail = all.slice(-AZURE_LOG_LINES);
  let truncated = earlier || all.length > tail.length;
  const out: AzureLogLine[] = [];
  let bytes = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i]!;
    const m = STAMP.exec(line);
    const rest = m ? line.slice(m[0].length) : line;
    const text = sanitizeLogLine(rest, secrets);
    const size = Buffer.byteLength(text, "utf8") + 1;
    if (bytes + size > AZURE_LOG_MAX_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    const at = m ? new Date(m[1]!) : null;
    out.push({
      at: at && Number.isFinite(at.getTime()) ? at.toISOString() : null,
      stream: /^##\[error\]/.test(rest)
        ? "err"
        : /^##\[(command|section)\]/.test(rest)
          ? "cmd"
          : "out",
      text,
    });
  }
  out.reverse();
  return { lines: out, truncated };
}
