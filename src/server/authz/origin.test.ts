import { describe, expect, it } from "vitest";
import { ACTION_BUCKET, refill } from "./bucket";
import { firstAddress, originAllowed } from "./origin";

describe("originAllowed", () => {
  const base = "https://devops.example.com";

  it("accepts the public base URL's origin only", () => {
    expect(originAllowed("https://devops.example.com", base)).toBe(true);
    expect(originAllowed("https://devops.example.com/", base)).toBe(true);
    expect(originAllowed("http://devops.example.com", base)).toBe(false);
    expect(originAllowed("https://devops.example.com:8443", base)).toBe(false);
    expect(originAllowed("https://evil.example.org", base)).toBe(false);
    expect(originAllowed("https://devops.example.com.example.org", base)).toBe(
      false,
    );
  });

  it("refuses missing, opaque and malformed origins", () => {
    expect(originAllowed(null, base)).toBe(false);
    expect(originAllowed(undefined, base)).toBe(false);
    expect(originAllowed("null", base)).toBe(false);
    expect(originAllowed("not a url", base)).toBe(false);
  });
});

describe("firstAddress", () => {
  it("takes the client address of a forwarded-for chain", () => {
    expect(firstAddress("192.0.2.1, 198.51.100.2")).toBe("192.0.2.1");
    expect(firstAddress(" 2001:db8::1 ")).toBe("2001:db8::1");
    expect(firstAddress("")).toBeNull();
    expect(firstAddress(null)).toBeNull();
  });
});

describe("action token bucket", () => {
  it("refills 30 tokens per minute up to the capacity", () => {
    expect(ACTION_BUCKET.capacity).toBe(30);
    expect(refill(0, 60, ACTION_BUCKET)).toBe(30);
    expect(refill(0, 2, ACTION_BUCKET)).toBe(1);
    expect(refill(29, 3600, ACTION_BUCKET)).toBe(30);
    expect(refill(-10, 20, ACTION_BUCKET)).toBe(0);
    expect(refill(5, -10, ACTION_BUCKET)).toBe(5);
  });
});
