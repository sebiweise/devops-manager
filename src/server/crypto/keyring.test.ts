import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKeyRing, reencrypt } from "./keyring";

const key = () => randomBytes(32).toString("base64");

describe("token key ring", () => {
  it("round-trips a value", () => {
    const ring = createKeyRing(key());
    const ct = ring.encrypt("ghu_exampletoken", "credential:1:accessToken");
    expect(ct).toMatch(
      /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/,
    );
    expect(ct).not.toContain("ghu_exampletoken");
    expect(ring.decrypt(ct, "credential:1:accessToken")).toBe(
      "ghu_exampletoken",
    );
  });

  it("round-trips unicode and empty strings", () => {
    const ring = createKeyRing(key());
    expect(ring.decrypt(ring.encrypt(""))).toBe("");
    expect(ring.decrypt(ring.encrypt("Grüße ✓"))).toBe("Grüße ✓");
  });

  it("uses a fresh IV for every encryption", () => {
    const ring = createKeyRing(key());
    expect(ring.encrypt("same")).not.toBe(ring.encrypt("same"));
  });

  it("refuses a ciphertext with different associated data", () => {
    const ring = createKeyRing(key());
    const ct = ring.encrypt("secret", "row:1");
    expect(() => ring.decrypt(ct, "row:2")).toThrow();
  });

  it("detects tampering", () => {
    const ring = createKeyRing(key());
    const parts = ring.encrypt("secret").split(":");
    const ct = Buffer.from(parts[3]!, "base64url");
    ct[0] = ct[0]! ^ 1;
    parts[3] = ct.toString("base64url");
    expect(() => ring.decrypt(parts.join(":"))).toThrow();
  });

  it("decrypts with the previous key after rotation and re-encrypts with the current one", () => {
    const oldKey = key();
    const newKey = key();
    const oldRing = createKeyRing(oldKey);
    const ct = oldRing.encrypt("value", "aad");

    const rotated = createKeyRing(newKey, oldKey);
    expect(rotated.decrypt(ct, "aad")).toBe("value");
    expect(rotated.needsReencrypt(ct)).toBe(true);

    const fresh = reencrypt(rotated, ct, "aad");
    expect(rotated.needsReencrypt(fresh)).toBe(false);
    expect(createKeyRing(newKey).decrypt(fresh, "aad")).toBe("value");
  });

  it("fails for an unknown key id and malformed input", () => {
    const ct = createKeyRing(key()).encrypt("value");
    expect(() => createKeyRing(key()).decrypt(ct)).toThrow(
      /Unknown encryption key/,
    );
    expect(() => createKeyRing(key()).decrypt("v2:a:b:c:d")).toThrow();
    expect(() => createKeyRing(key()).decrypt("not a ciphertext")).toThrow();
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => createKeyRing(randomBytes(16).toString("base64"))).toThrow(
      /32 bytes/,
    );
  });
});
