import { describe, expect, it } from "vitest";
import { describeError } from "./describe-error";

describe("describeError", () => {
  it("adds status, method, path and message of an HTTP error", () => {
    const error = Object.assign(
      new Error("Resource not accessible by integration"),
      {
        name: "HttpError",
        status: 403,
        request: {
          method: "GET",
          url: "https://api.github.com/repos/example-org/repo-a/actions/variables?per_page=100",
        },
      },
    );
    expect(describeError(error)).toBe(
      "HttpError · 403 · GET /repos/example-org/repo-a/actions/variables · Resource not accessible by integration",
    );
  });

  it("redacts tokens in the message", () => {
    const error = new Error(
      "bad credentials for token ghs_abcdefghijklmnopqrstuvwxyz",
    );
    expect(describeError(error)).not.toContain("ghs_abcdefghijklmnop");
  });

  it("handles non-errors", () => {
    expect(describeError("x")).toBe("unknown");
  });
});
