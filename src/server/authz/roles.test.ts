import { describe, expect, it } from "vitest";
import {
  assertAdminRuleExists,
  evaluateSignIn,
  hasRole,
  maxRole,
  readGroupsClaim,
  resolveEnvRole,
  resolveRole,
  type Identity,
  type Role,
  type RoleRules,
} from "./roles";

const rules: RoleRules = {
  adminEmails: ["admin@example.com"],
  adminGroups: ["devops-admins"],
  operatorEmails: ["ops@example.com"],
  operatorGroups: ["devops-operators"],
  viewerEmails: ["viewer@example.org"],
  viewerGroups: ["devops-viewers"],
  defaultRole: "none",
};

const id = (
  email: string | null,
  groups: string[] = [],
  emailVerified = true,
): Identity => ({
  email,
  emailVerified,
  groups,
});

const gate = { allowedGroups: [], requireVerifiedEmail: true };

describe("role ordering", () => {
  it("orders VIEWER < OPERATOR < ADMIN", () => {
    expect(hasRole("ADMIN", "OPERATOR")).toBe(true);
    expect(hasRole("ADMIN", "VIEWER")).toBe(true);
    expect(hasRole("OPERATOR", "OPERATOR")).toBe(true);
    expect(hasRole("OPERATOR", "ADMIN")).toBe(false);
    expect(hasRole("VIEWER", "OPERATOR")).toBe(false);
    expect(hasRole(null, "VIEWER")).toBe(false);
    expect(maxRole("VIEWER", null, "ADMIN", "OPERATOR")).toBe("ADMIN");
    expect(maxRole(null, undefined)).toBeNull();
  });
});

describe("resolveEnvRole matrix", () => {
  const cases: Array<[string, Identity, Role | null]> = [
    ["admin by email", id("admin@example.com"), "ADMIN"],
    ["admin by group", id("someone@example.com", ["devops-admins"]), "ADMIN"],
    ["operator by email", id("ops@example.com"), "OPERATOR"],
    [
      "operator by group",
      id("someone@example.com", ["devops-operators"]),
      "OPERATOR",
    ],
    ["viewer by email", id("viewer@example.org"), "VIEWER"],
    [
      "viewer by group",
      id("someone@example.com", ["devops-viewers"]),
      "VIEWER",
    ],
    ["no match", id("someone@example.com", ["other"]), null],
    ["email match is case-insensitive", id("Admin@Example.COM"), "ADMIN"],
    [
      "group match is case-insensitive",
      id("x@example.com", ["DevOps-Admins"]),
      "ADMIN",
    ],
    [
      "highest match wins (viewer email + admin group)",
      id("viewer@example.org", ["devops-admins"]),
      "ADMIN",
    ],
    [
      "highest match wins (operator email + viewer group)",
      id("ops@example.com", ["devops-viewers"]),
      "OPERATOR",
    ],
    [
      "highest of several groups",
      id("x@example.com", ["devops-viewers", "devops-operators"]),
      "OPERATOR",
    ],
    [
      "unverified email does not count",
      id("admin@example.com", [], false),
      null,
    ],
    [
      "unverified email, group still counts",
      id("admin@example.com", ["devops-operators"], false),
      "OPERATOR",
    ],
    ["missing email", id(null, ["devops-viewers"]), "VIEWER"],
    ["email in a group list does not match", id("devops-admins"), null],
  ];

  it.each(cases)("%s", (_name, identity, expected) => {
    expect(resolveEnvRole(identity, rules)).toBe(expected);
  });

  it("applies DEFAULT_ROLE=viewer to users matching no rule", () => {
    expect(
      resolveEnvRole(id("someone@example.com"), {
        ...rules,
        defaultRole: "viewer",
      }),
    ).toBe("VIEWER");
    expect(
      resolveEnvRole(id("ops@example.com"), {
        ...rules,
        defaultRole: "viewer",
      }),
    ).toBe("OPERATOR");
  });

  it("ignores empty allowlists", () => {
    const empty: RoleRules = {
      adminEmails: [],
      adminGroups: [],
      operatorEmails: [],
      operatorGroups: [],
      viewerEmails: [],
      viewerGroups: [],
      defaultRole: "none",
    };
    expect(
      resolveEnvRole(id("admin@example.com", ["devops-admins"]), empty),
    ).toBeNull();
  });
});

describe("resolveRole with stored overrides", () => {
  it("raises the env role with an override", () => {
    expect(
      resolveRole(id("viewer@example.org"), { roleOverride: "ADMIN" }, rules),
    ).toBe("ADMIN");
  });

  it("never lowers an env role (env is a floor)", () => {
    expect(
      resolveRole(id("admin@example.com"), { roleOverride: "VIEWER" }, rules),
    ).toBe("ADMIN");
  });

  it("grants an override to a user without an env role", () => {
    expect(
      resolveRole(
        id("someone@example.com"),
        { roleOverride: "OPERATOR" },
        rules,
      ),
    ).toBe("OPERATOR");
  });

  it("disables users without an env role", () => {
    expect(
      resolveRole(
        id("someone@example.com"),
        { roleOverride: "OPERATOR", disabledAt: new Date() },
        rules,
      ),
    ).toBeNull();
  });

  it("cannot disable env-assigned users (break-glass)", () => {
    expect(
      resolveRole(id("admin@example.com"), { disabledAt: new Date() }, rules),
    ).toBe("ADMIN");
  });

  it("DEFAULT_ROLE does not protect a disabled user", () => {
    expect(
      resolveRole(
        id("someone@example.com"),
        { disabledAt: new Date() },
        { ...rules, defaultRole: "viewer" },
      ),
    ).toBeNull();
  });
});

describe("evaluateSignIn (sign-in gate)", () => {
  it("admits a user with a role", () => {
    expect(evaluateSignIn(id("ops@example.com"), {}, rules, gate)).toEqual({
      ok: true,
      role: "OPERATOR",
      groups: [],
    });
  });

  it("refuses a user matching no rule", () => {
    expect(evaluateSignIn(id("someone@example.com"), {}, rules, gate)).toEqual({
      ok: false,
      error: "no_access",
    });
  });

  it("refuses an unverified email that only matches an email rule", () => {
    expect(
      evaluateSignIn(id("admin@example.com", [], false), {}, rules, gate),
    ).toEqual({
      ok: false,
      error: "no_access",
    });
  });

  it("trusts the email when verification is not required", () => {
    const relaxed = { ...gate, requireVerifiedEmail: false };
    expect(
      evaluateSignIn(id("admin@example.com", [], false), {}, rules, relaxed),
    ).toMatchObject({
      ok: true,
      role: "ADMIN",
    });
  });

  it("refuses users outside OIDC_ALLOWED_GROUPS even with a role", () => {
    const restricted = { ...gate, allowedGroups: ["devops-users"] };
    expect(
      evaluateSignIn(id("admin@example.com", ["other"]), {}, rules, restricted),
    ).toEqual({
      ok: false,
      error: "not_in_allowed_group",
    });
    expect(
      evaluateSignIn(id("admin@example.com", []), {}, rules, restricted),
    ).toEqual({
      ok: false,
      error: "not_in_allowed_group",
    });
  });

  it("admits members of an allowed group that also resolve a role", () => {
    const restricted = { ...gate, allowedGroups: ["devops-users"] };
    expect(
      evaluateSignIn(
        id("x@example.com", ["devops-users", "devops-viewers"]),
        {},
        rules,
        restricted,
      ),
    ).toMatchObject({ ok: true, role: "VIEWER" });
    expect(
      evaluateSignIn(
        id("x@example.com", ["devops-users"]),
        {},
        rules,
        restricted,
      ),
    ).toEqual({
      ok: false,
      error: "no_access",
    });
  });

  it("refuses a disabled user without an env role", () => {
    expect(
      evaluateSignIn(
        id("x@example.com"),
        { roleOverride: "VIEWER", disabledAt: new Date() },
        rules,
        gate,
      ),
    ).toEqual({ ok: false, error: "no_access" });
  });
});

describe("boot check and claim parsing", () => {
  it("refuses to boot without an admin rule", () => {
    expect(() =>
      assertAdminRuleExists({ adminEmails: [], adminGroups: [] }),
    ).toThrow(/ADMIN_EMAILS/);
    expect(() =>
      assertAdminRuleExists({
        adminEmails: [],
        adminGroups: ["devops-admins"],
      }),
    ).not.toThrow();
    expect(() =>
      assertAdminRuleExists({
        adminEmails: ["admin@example.com"],
        adminGroups: [],
      }),
    ).not.toThrow();
  });

  it("reads array, string and missing groups claims", () => {
    expect(readGroupsClaim({ groups: ["a", "b", 3] }, "groups")).toEqual([
      "a",
      "b",
    ]);
    expect(readGroupsClaim({ roles: "a, b c" }, "roles")).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(readGroupsClaim({}, "groups")).toEqual([]);
    expect(readGroupsClaim({ groups: { a: 1 } }, "groups")).toEqual([]);
  });
});
