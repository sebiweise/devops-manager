import { describe, expect, it } from "vitest";
import {
  isMutationPurpose,
  mergePurposeFor,
  PermissionNotGrantedError,
  permissionsFor,
  PURPOSES,
  type TokenPurpose,
} from "./purposes";

const manage: Record<string, string | undefined> = {
  metadata: "read",
  actions: "write",
  contents: "write",
  pull_requests: "write",
  workflows: "write",
  checks: "read",
  statuses: "read",
  actions_variables: "write",
  vulnerability_alerts: "read",
  administration: "read",
};

describe("token purposes", () => {
  it("requests exactly the purpose's permission set", () => {
    expect(permissionsFor("sync.inventory", manage)).toEqual({
      metadata: "read",
    });
    expect(permissionsFor("sync.runs", manage)).toEqual({
      metadata: "read",
      actions: "read",
    });
    expect(permissionsFor("act.runs", manage)).toEqual({ actions: "write" });
    expect(permissionsFor("act.merge", manage)).toEqual({
      contents: "write",
      pull_requests: "write",
    });
    expect(permissionsFor("act.merge.workflows", manage)).toEqual({
      contents: "write",
      pull_requests: "write",
      workflows: "write",
    });
  });

  it("adds optional permissions only when granted", () => {
    expect(permissionsFor("read.pulls", manage)).toEqual({
      pull_requests: "read",
      contents: "read",
      checks: "read",
      statuses: "read",
    });
    expect(
      permissionsFor("read.pulls", { pull_requests: "read", contents: "read" }),
    ).toEqual({
      pull_requests: "read",
      contents: "read",
    });
    expect(permissionsFor("sync.runners", manage)).toEqual({
      administration: "read",
    });
  });

  it("accepts write where read is required", () => {
    expect(permissionsFor("read.variables", manage)).toEqual({
      actions_variables: "read",
    });
  });

  it("throws PermissionNotGrantedError when a required permission is missing", () => {
    expect(() =>
      permissionsFor("act.runs", { ...manage, actions: "read" }),
    ).toThrow(PermissionNotGrantedError);
    expect(() =>
      permissionsFor("act.merge.workflows", {
        ...manage,
        workflows: undefined,
      }),
    ).toThrow(/workflows:write/);
  });

  it("marks every act.* purpose as a mutation", () => {
    for (const purpose of Object.keys(PURPOSES) as TokenPurpose[]) {
      expect(isMutationPurpose(purpose)).toBe(purpose.startsWith("act."));
    }
  });

  it("chooses the workflows merge token only for PRs touching .github/workflows/", () => {
    expect(mergePurposeFor(["src/index.ts", "package.json"])).toBe("act.merge");
    expect(mergePurposeFor([".github/dependabot.yml"])).toBe("act.merge");
    expect(mergePurposeFor([".github/workflows/ci.yml"])).toBe(
      "act.merge.workflows",
    );
  });
});
