import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRESETS,
  isValidVariableName,
  isValidVariableValue,
  parsePresets,
  planBulkSet,
  planRevert,
  PresetConfigError,
  type RepoVariableState,
} from "./variable-rules";

describe("variable names and values", () => {
  it("accepts GitHub's variable names", () => {
    for (const name of ["LINUX_RUNNER", "_x", "a1", "MACOS_RUNNER"])
      expect(isValidVariableName(name), name).toBe(true);
  });

  it("refuses invalid names, GITHUB_ prefixes and overlong names", () => {
    for (const name of [
      "",
      "1ABC",
      "with-dash",
      "with space",
      "GITHUB_TOKEN",
      "github_anything",
      "A".repeat(256),
    ])
      expect(isValidVariableName(name), name).toBe(false);
    expect(isValidVariableName("A".repeat(255))).toBe(true);
  });

  it("limits values to 48 KB of UTF-8 and refuses empty values", () => {
    expect(isValidVariableValue("")).toBe(false);
    expect(isValidVariableValue("x".repeat(48 * 1024))).toBe(true);
    expect(isValidVariableValue("x".repeat(48 * 1024 + 1))).toBe(false);
    // Three bytes per character in UTF-8.
    expect(isValidVariableValue("€".repeat(16 * 1024))).toBe(true);
    expect(isValidVariableValue("€".repeat(16 * 1024 + 1))).toBe(false);
  });
});

describe("VARIABLE_PRESETS", () => {
  it("defaults to LINUX_RUNNER and MACOS_RUNNER with generic values", () => {
    expect(parsePresets(undefined)).toEqual(DEFAULT_PRESETS);
    expect(parsePresets("  ")).toEqual(DEFAULT_PRESETS);
    expect(parsePresets(undefined)[0]).toEqual({
      name: "LINUX_RUNNER",
      values: ["self-hosted", "ubuntu-latest"],
      scope: "repository",
    });
  });

  it("parses instance presets, defaulting and normalising the scope", () => {
    expect(
      parsePresets(
        JSON.stringify([
          { name: "LINUX_RUNNER", values: ["runner-1", "ubuntu-latest"] },
          { name: "ORG_RUNNER", values: ["a", "a", "b"], scope: "org" },
        ]),
      ),
    ).toEqual([
      {
        name: "LINUX_RUNNER",
        values: ["runner-1", "ubuntu-latest"],
        scope: "repository",
      },
      { name: "ORG_RUNNER", values: ["a", "b"], scope: "organization" },
    ]);
  });

  it("refuses invalid JSON, names, values, scopes and duplicates", () => {
    for (const raw of [
      "{",
      "{}",
      JSON.stringify([{ name: "GITHUB_X", values: ["a"] }]),
      JSON.stringify([{ name: "OK", values: [] }]),
      JSON.stringify([{ name: "OK", values: [""] }]),
      JSON.stringify([{ name: "OK", values: [1] }]),
      JSON.stringify([{ name: "OK", values: ["a"], scope: "enterprise" }]),
      JSON.stringify([
        { name: "OK", values: ["a"] },
        { name: "ok", values: ["b"] },
      ]),
    ])
      expect(() => parsePresets(raw), raw).toThrow(PresetConfigError);
  });
});

const state = (
  id: string,
  current: string | null | undefined,
  extra: Partial<RepoVariableState> = {},
): RepoVariableState => ({
  repositoryId: id,
  fullName: `example-org/repo-${id}`,
  archived: false,
  selected: true,
  current,
  ...extra,
});

describe("planBulkSet", () => {
  it("shows current -> new, marks unchanged and unwritable repos", () => {
    const rows = planBulkSet(
      [
        state("1", null),
        state("2", "ubuntu-latest"),
        state("3", "self-hosted"),
        state("4", "ubuntu-latest", { archived: true }),
        state("5", null, { selected: false }),
        state("6", undefined),
      ],
      "self-hosted",
    );
    expect(rows.map((r) => [r.repositoryId, r.change, r.reason])).toEqual([
      ["1", "create", undefined],
      ["2", "update", undefined],
      ["3", "unchanged", undefined],
      ["4", "skipped", "archived"],
      ["5", "skipped", "not_selected"],
      ["6", "skipped", "unreadable"],
    ]);
    expect(rows[1]).toMatchObject({
      current: "ubuntu-latest",
      next: "self-hosted",
    });
  });
});

describe("planRevert", () => {
  const writes = [
    { repositoryId: "1", fullName: "r1", before: null, after: "self-hosted" },
    {
      repositoryId: "2",
      fullName: "r2",
      before: "ubuntu-latest",
      after: "self-hosted",
    },
    {
      repositoryId: "3",
      fullName: "r3",
      before: "ubuntu-latest",
      after: "self-hosted",
    },
    {
      repositoryId: "4",
      fullName: "r4",
      before: "ubuntu-latest",
      after: "self-hosted",
    },
    {
      repositoryId: "5",
      fullName: "r5",
      before: "ubuntu-latest",
      after: "self-hosted",
    },
  ];

  it("restores before values, deletes created ones and skips drifted repos", () => {
    const live = new Map([
      ["1", { archived: false, selected: true, current: "self-hosted" }],
      ["2", { archived: false, selected: true, current: "self-hosted" }],
      ["3", { archived: false, selected: true, current: "macos-latest" }],
      ["4", { archived: false, selected: true, current: "ubuntu-latest" }],
      ["5", { archived: true, selected: true, current: "self-hosted" }],
    ]);
    expect(
      planRevert(writes, live).map((r) => [
        r.repositoryId,
        r.change,
        r.target,
        r.reason,
      ]),
    ).toEqual([
      ["1", "delete", null, undefined],
      ["2", "restore", "ubuntu-latest", undefined],
      ["3", "skipped", "ubuntu-latest", "drifted"],
      ["4", "unchanged", "ubuntu-latest", undefined],
      ["5", "skipped", "ubuntu-latest", "archived"],
    ]);
  });

  it("skips repos that left the installation or could not be read", () => {
    const live = new Map([
      ["1", { archived: false, selected: true, current: undefined }],
    ]);
    expect(planRevert(writes.slice(0, 2), live).map((r) => r.reason)).toEqual([
      "unreadable",
      "not_selected",
    ]);
  });
});
