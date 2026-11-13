import { describe, expect, it } from "vitest";
import {
  buildLogExcerpt,
  LOG_LINE_MAX,
  LOG_TOTAL_MAX_BYTES,
  sanitizeLogLine,
} from "./log-excerpt";

/** The build log excerpt (design addendum D8): scrubbed, plain text, capped. */

const TOKEN = "plain-token-without-prefix-0042";
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("build log excerpt", () => {
  it("removes the call's token, known token patterns, ANSI and control characters", () => {
    expect(
      sanitizeLogLine(
        `${ESC}[31mfetch failed${ESC}[0m with ${TOKEN}${BEL} and vcp_abcdefghijklmnop1234`,
        [TOKEN],
      ),
    ).toBe("fetch failed with [redacted] and [redacted]");
    expect(
      sanitizeLogLine(
        "curl -H 'Authorization: Bearer ghp_aaaaaaaaaaaaaaaa'",
        [],
      ),
    ).not.toMatch(/ghp_/);
    expect(sanitizeLogLine("GITHUB_TOKEN=abc123secret npm i", [])).toBe(
      "GITHUB_TOKEN=[redacted] npm i",
    );
    expect(sanitizeLogLine("x".repeat(5000), [])).toHaveLength(LOG_LINE_MAX);
  });

  it("splits multi-line events, maps streams and caps the total size", () => {
    const at = new Date(Date.UTC(2026, 10, 13, 8));
    const ex = buildLogExcerpt(
      [
        { at, type: "command", text: "pnpm build" },
        { at, type: "stdout", text: "compiling\nok" },
        { at, type: "stderr", text: "Error: boom" },
      ],
      [],
    );
    expect(ex.lines.map((l) => [l.stream, l.text])).toEqual([
      ["cmd", "pnpm build"],
      ["out", "compiling"],
      ["out", "ok"],
      ["err", "Error: boom"],
    ]);
    expect(ex.truncated).toBe(false);

    const big = Array.from({ length: 200 }, (_, i) => ({
      at,
      type: "stdout",
      text: `${i} ${"y".repeat(1990)}`,
    }));
    const capped = buildLogExcerpt(big, []);
    expect(capped.truncated).toBe(true);
    const bytes = capped.lines.reduce((s, l) => s + l.text.length + 1, 0);
    expect(bytes).toBeLessThanOrEqual(LOG_TOTAL_MAX_BYTES);
    // The newest lines are kept.
    expect(capped.lines.at(-1)!.text.startsWith("199 ")).toBe(true);
  });
});
