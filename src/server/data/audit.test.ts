import { describe, expect, it } from "vitest";
import { csvCell, sanitiseParams } from "./audit";

describe("audit CSV cells", () => {
  it("quotes separators and neutralises spreadsheet formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@sum")).toBe("'@sum");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe("sanitiseParams", () => {
  it("never returns a sealed variable value", () => {
    const params = {
      name: "LINUX_RUNNER",
      before: { sha256: "ab", length: 3, sealed: "v1:k:iv:ct:tag" },
      after: "self-hosted",
      nested: [{ value: { sha256: "cd", length: 1, sealed: "x" } }],
    };
    expect(sanitiseParams(params)).toEqual({
      name: "LINUX_RUNNER",
      before: { redacted: true, sha256: "ab", length: 3 },
      after: "self-hosted",
      nested: [{ value: { redacted: true, sha256: "cd", length: 1 } }],
    });
    expect(JSON.stringify(sanitiseParams(params))).not.toContain("sealed");
  });
});
