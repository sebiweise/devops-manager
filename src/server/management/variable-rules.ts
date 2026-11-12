/**
 * Rules for GitHub Actions variables and the runs-on switch presets (design
 * §8.2 "Variable rules", "Presets", D7). Pure: no env, no DB, so the parser
 * is unit-tested and also used by the boot-time env validation.
 *
 * - Names match `^[A-Za-z_][A-Za-z0-9_]*$`, do not start with `GITHUB_`
 *   (case-insensitive) and are at most 255 characters.
 * - Values are non-empty and at most 48 KB (UTF-8 bytes).
 * - Variables are not secrets; secrets are never touched.
 */

export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_NAME_LENGTH = 255;
export const MAX_VALUE_BYTES = 48 * 1024;

export function isValidVariableName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_NAME_LENGTH &&
    VARIABLE_NAME.test(name) &&
    !/^github_/i.test(name)
  );
}

export function isValidVariableValue(value: string): boolean {
  return (
    value.length > 0 &&
    new TextEncoder().encode(value).length <= MAX_VALUE_BYTES
  );
}

export type PresetScope = "repository" | "organization";

export type VariablePreset = {
  name: string;
  /** The values the preset switches between, e.g. a self-hosted label and a hosted image. */
  values: string[];
  scope: PresetScope;
};

/**
 * Shipped defaults: generic values only. Instance-specific values (such as
 * the label of a private runner pool) belong in `VARIABLE_PRESETS` of the
 * instance env and are never committed (D9).
 */
export const DEFAULT_PRESETS: readonly VariablePreset[] = [
  {
    name: "LINUX_RUNNER",
    values: ["self-hosted", "ubuntu-latest"],
    scope: "repository",
  },
  {
    name: "MACOS_RUNNER",
    values: ["self-hosted", "macos-latest"],
    scope: "repository",
  },
];

export class PresetConfigError extends Error {
  constructor(message: string) {
    super(`VARIABLE_PRESETS: ${message}`);
    this.name = "PresetConfigError";
  }
}

/**
 * Parses `VARIABLE_PRESETS` (a JSON list of `{name, values[], scope}`).
 * Empty or unset means the shipped defaults. `scope` defaults to
 * "repository"; "repo" and "org" are accepted as short forms. Throws
 * `PresetConfigError` on invalid input, so a typo fails at boot instead of
 * silently showing no presets.
 */
export function parsePresets(raw: string | undefined | null): VariablePreset[] {
  if (raw == null || raw.trim() === "")
    return DEFAULT_PRESETS.map((p) => ({ ...p, values: [...p.values] }));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PresetConfigError("must be valid JSON");
  }
  if (!Array.isArray(parsed))
    throw new PresetConfigError("must be a JSON list");
  if (parsed.length > 50)
    throw new PresetConfigError("at most 50 presets are supported");
  const seen = new Set<string>();
  return parsed.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new PresetConfigError(`entry ${i} must be an object`);
    const { name, values, scope } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !isValidVariableName(name))
      throw new PresetConfigError(`entry ${i} has an invalid variable name`);
    if (
      !Array.isArray(values) ||
      values.length < 1 ||
      values.length > 20 ||
      !values.every((v) => typeof v === "string" && isValidVariableValue(v))
    )
      throw new PresetConfigError(
        `entry ${i} (${name}) needs 1 to 20 non-empty string values`,
      );
    const unique = [...new Set(values as string[])];
    let presetScope: PresetScope;
    if (scope === undefined || scope === "repository" || scope === "repo")
      presetScope = "repository";
    else if (scope === "organization" || scope === "org")
      presetScope = "organization";
    else
      throw new PresetConfigError(
        `entry ${i} (${name}) has an unknown scope; use "repository" or "organization"`,
      );
    const key = `${presetScope}:${name.toUpperCase()}`;
    if (seen.has(key))
      throw new PresetConfigError(`${name} is listed twice for ${presetScope}`);
    seen.add(key);
    return { name, values: unique, scope: presetScope };
  });
}

// ---------- bulk set and revert plans ----------

/** What GitHub currently holds for one target repo of a bulk set. */
export type RepoVariableState = {
  repositoryId: string;
  fullName: string;
  archived: boolean;
  /** False when the repo left the installation's repository selection. */
  selected: boolean;
  /** Current value; null = not set; undefined = could not be read. */
  current: string | null | undefined;
};

export type BulkChange = "create" | "update" | "unchanged" | "skipped";
export type SkipReason = "archived" | "not_selected" | "unreadable";

export type BulkRow = {
  repositoryId: string;
  fullName: string;
  current: string | null;
  next: string;
  change: BulkChange;
  reason?: SkipReason;
};

/** The preview diff of a bulk set: repo, current -> new, unchanged and unwritable repos marked. */
export function planBulkSet(
  states: readonly RepoVariableState[],
  value: string,
): BulkRow[] {
  return states.map((s) => {
    const base = {
      repositoryId: s.repositoryId,
      fullName: s.fullName,
      current: s.current ?? null,
      next: value,
    };
    if (!s.selected)
      return { ...base, change: "skipped", reason: "not_selected" };
    if (s.archived) return { ...base, change: "skipped", reason: "archived" };
    if (s.current === undefined)
      return { ...base, change: "skipped", reason: "unreadable" };
    if (s.current === value) return { ...base, change: "unchanged" };
    return { ...base, change: s.current === null ? "create" : "update" };
  });
}

/** One successful child write of a batch, as recorded in the audit log. */
export type BatchWrite = {
  repositoryId: string;
  fullName: string;
  before: string | null;
  after: string | null;
};

export type RevertChange = "restore" | "delete" | "unchanged" | "skipped";
export type RevertSkipReason = SkipReason | "drifted";

export type RevertRow = {
  repositoryId: string;
  fullName: string;
  /** What GitHub holds now. */
  current: string | null;
  /** What the revert writes (null = delete). */
  target: string | null;
  change: RevertChange;
  reason?: RevertSkipReason;
};

/**
 * The preview of a batch revert: every successful write is undone with its
 * recorded `before` value, and variables the batch created are deleted. A
 * repo whose value changed after the batch ("drifted") is skipped, so a
 * later change by someone else is never overwritten.
 */
export function planRevert(
  writes: readonly BatchWrite[],
  live: ReadonlyMap<
    string,
    Pick<RepoVariableState, "archived" | "selected" | "current">
  >,
): RevertRow[] {
  return writes.map((w) => {
    const state = live.get(w.repositoryId);
    const base = {
      repositoryId: w.repositoryId,
      fullName: w.fullName,
      current: state?.current ?? null,
      target: w.before,
    };
    if (!state || !state.selected)
      return { ...base, change: "skipped", reason: "not_selected" };
    if (state.archived)
      return { ...base, change: "skipped", reason: "archived" };
    if (state.current === undefined)
      return { ...base, change: "skipped", reason: "unreadable" };
    if (state.current === w.before) return { ...base, change: "unchanged" };
    if (state.current !== w.after)
      return { ...base, change: "skipped", reason: "drifted" };
    return { ...base, change: w.before === null ? "delete" : "restore" };
  });
}
