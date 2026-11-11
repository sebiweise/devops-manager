import { describe, expect, it } from "vitest";
import { signPayload, verifySignature } from "./verify";

// Official test vector from GitHub's "Validating webhook deliveries" docs.
const SECRET = "It's a Secret to Everybody";
const PAYLOAD = "Hello, World!";
const EXPECTED =
  "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

describe("webhook signature", () => {
  it("matches GitHub's official test vector", () => {
    expect(signPayload(SECRET, PAYLOAD)).toBe(EXPECTED);
    expect(verifySignature(PAYLOAD, EXPECTED, [SECRET])).toBe(true);
  });

  it("accepts bytes as well as strings", () => {
    expect(
      verifySignature(new TextEncoder().encode(PAYLOAD), EXPECTED, [SECRET]),
    ).toBe(true);
  });

  it("rejects a missing or empty header", () => {
    expect(verifySignature(PAYLOAD, null, [SECRET])).toBe(false);
    expect(verifySignature(PAYLOAD, undefined, [SECRET])).toBe(false);
    expect(verifySignature(PAYLOAD, "", [SECRET])).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    expect(
      verifySignature(PAYLOAD, EXPECTED.slice("sha256=".length), [SECRET]),
    ).toBe(false);
    expect(
      verifySignature(PAYLOAD, EXPECTED.replace("sha256=", "sha1="), [SECRET]),
    ).toBe(false);
  });

  it("rejects signatures of the wrong length", () => {
    expect(verifySignature(PAYLOAD, EXPECTED.slice(0, -2), [SECRET])).toBe(
      false,
    );
    expect(verifySignature(PAYLOAD, `${EXPECTED}00`, [SECRET])).toBe(false);
  });

  it("rejects a wrong secret, a changed body and a flipped digit", () => {
    expect(verifySignature(PAYLOAD, EXPECTED, ["another secret"])).toBe(false);
    expect(verifySignature(`${PAYLOAD} `, EXPECTED, [SECRET])).toBe(false);
    const flipped =
      EXPECTED.slice(0, -1) + (EXPECTED.endsWith("7") ? "8" : "7");
    expect(verifySignature(PAYLOAD, flipped, [SECRET])).toBe(false);
  });

  it("accepts the previous secret during rotation", () => {
    expect(verifySignature(PAYLOAD, EXPECTED, ["new secret", SECRET])).toBe(
      true,
    );
    const signedWithNew = signPayload("new secret", PAYLOAD);
    expect(
      verifySignature(PAYLOAD, signedWithNew, ["new secret", SECRET]),
    ).toBe(true);
  });

  it("fails closed without any configured secret", () => {
    expect(verifySignature(PAYLOAD, EXPECTED, [])).toBe(false);
    expect(verifySignature(PAYLOAD, EXPECTED, [undefined, null, ""])).toBe(
      false,
    );
  });
});
