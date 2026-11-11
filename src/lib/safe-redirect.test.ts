import { describe, expect, it } from "vitest";
import { safeNextPath } from "./safe-redirect";

describe("safeNextPath", () => {
  it("keeps same-origin paths", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("/o/example-org?range=7d")).toBe(
      "/o/example-org?range=7d",
    );
  });

  it("rejects absolute and protocol-relative URLs", () => {
    expect(safeNextPath("https://example.org/")).toBeNull();
    expect(safeNextPath("//example.org/")).toBeNull();
    expect(safeNextPath("/\\example.org")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });
});
