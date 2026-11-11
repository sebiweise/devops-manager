import { describe, expect, it } from "vitest";
import { baseSecurityHeaders, cspHeaderName, originOf, pageCsp } from "./csp";

describe("page CSP", () => {
  const csp = pageCsp({
    nonce: "abc123",
    formActionOrigins: ["https://id.example.com"],
  });
  const directive = (name: string) =>
    csp.split("; ").find((d) => d.startsWith(`${name} `) || d === name);

  it("uses the nonce and no unsafe-inline scripts", () => {
    expect(directive("script-src")).toBe(
      "script-src 'self' 'nonce-abc123' 'strict-dynamic'",
    );
    expect(directive("script-src")).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("forbids framing and plugins", () => {
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("object-src")).toBe("object-src 'none'");
  });

  it("allows only same-origin connections and GitHub avatars", () => {
    expect(directive("connect-src")).toBe("connect-src 'self'");
    expect(directive("img-src")).toBe(
      "img-src 'self' data: https://avatars.githubusercontent.com",
    );
  });

  it("allows form posts to the OIDC issuer", () => {
    expect(directive("form-action")).toBe(
      "form-action 'self' https://id.example.com",
    );
  });

  it("relaxes only what development needs", () => {
    const dev = pageCsp({ nonce: "n", isDev: true });
    expect(dev).toContain("unsafe-eval");
    expect(dev).not.toContain("upgrade-insecure-requests");
  });
});

describe("security headers", () => {
  it("sets HSTS in production only", () => {
    expect(baseSecurityHeaders(false).map((h) => h.key)).toContain(
      "Strict-Transport-Security",
    );
    expect(baseSecurityHeaders(true).map((h) => h.key)).not.toContain(
      "Strict-Transport-Security",
    );
  });

  it("supports report-only mode", () => {
    expect(cspHeaderName("true")).toBe("Content-Security-Policy-Report-Only");
    expect(cspHeaderName(undefined)).toBe("Content-Security-Policy");
  });

  it("extracts origins", () => {
    expect(originOf("https://id.example.com/realms/x")).toBe(
      "https://id.example.com",
    );
    expect(originOf("not a url")).toBeNull();
  });
});
