import { describe, expect, it } from "vitest";
import { billingTokenSchema, csv, resolveFileSecrets } from "./env";

describe("resolveFileSecrets", () => {
  const files: Record<string, string> = {
    "/run/secrets/oidc": "file-secret\n",
  };
  const read = (path: string) => {
    const value = files[path];
    if (value === undefined) throw new Error("missing");
    return value;
  };

  it("reads <NAME>_FILE when <NAME> is unset", () => {
    const out = resolveFileSecrets(
      { OIDC_CLIENT_SECRET_FILE: "/run/secrets/oidc" },
      read,
    );
    expect(out.OIDC_CLIENT_SECRET).toBe("file-secret");
  });

  it("prefers a set variable over the file", () => {
    const out = resolveFileSecrets(
      {
        OIDC_CLIENT_SECRET: "env",
        OIDC_CLIENT_SECRET_FILE: "/run/secrets/oidc",
      },
      read,
    );
    expect(out.OIDC_CLIENT_SECRET).toBe("env");
  });

  it("ignores _FILE for names that are not secrets", () => {
    expect(
      resolveFileSecrets({ LOG_LEVEL_FILE: "/run/secrets/oidc" }, read)
        .LOG_LEVEL,
    ).toBeUndefined();
  });
});

describe("csv", () => {
  it("splits, trims and drops empty entries", () => {
    expect(csv(" a@example.com, ,b@example.com ")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(csv(undefined)).toEqual([]);
  });
});

describe("billingTokenSchema", () => {
  it("accepts fine-grained PATs and an empty value", () => {
    const pat = "github_pat_" + "a".repeat(40);
    expect(billingTokenSchema.parse(pat)).toBe(pat);
    expect(billingTokenSchema.parse("")).toBeUndefined();
    expect(billingTokenSchema.parse(undefined)).toBeUndefined();
  });

  it("refuses classic and OAuth tokens", () => {
    expect(billingTokenSchema.safeParse("ghp_" + "a".repeat(36)).success).toBe(
      false,
    );
    expect(billingTokenSchema.safeParse("gho_" + "a".repeat(36)).success).toBe(
      false,
    );
  });
});
