import { describe, expect, it } from "vitest";
import { githubErrorInfo, requestIdOf } from "./errors";

describe("githubErrorInfo", () => {
  it("keeps GitHub's message verbatim, with status and request id", () => {
    const error = Object.assign(new Error("Head branch was modified - docs"), {
      status: 409,
      response: {
        data: {
          message: "Head branch was modified. Review and try the merge again.",
        },
        headers: { "x-github-request-id": "ABCD:1234" },
      },
    });
    expect(githubErrorInfo(error)).toEqual({
      status: 409,
      message: "Head branch was modified. Review and try the merge again.",
      requestId: "ABCD:1234",
    });
  });

  it("falls back to the error message and to a generic text", () => {
    expect(githubErrorInfo(new Error("socket hang up"))).toEqual({
      status: null,
      message: "socket hang up",
      requestId: null,
    });
    expect(githubErrorInfo("boom").message).toBe("Unknown error");
  });

  it("reads the request id of a successful response", () => {
    expect(requestIdOf({ "x-github-request-id": "X:1" })).toBe("X:1");
    expect(requestIdOf({})).toBeNull();
  });
});
