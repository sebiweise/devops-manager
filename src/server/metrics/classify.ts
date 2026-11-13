/**
 * Runner classification and job naming (design §6.4). Pure functions; the
 * fold calls them on every write so the derived columns always follow the
 * merged job row.
 */

import { compareCodeUnits } from "@/lib/compare";

export type RunnerKind =
  "GITHUB_HOSTED" | "LARGER_HOSTED" | "SELF_HOSTED" | "UNKNOWN";
export type RunnerOs = "LINUX" | "WINDOWS" | "MACOS" | "UNKNOWN";

/** The SkuRate fields classification and cost estimates read. */
export type SkuRateLike = {
  sku: string;
  os: RunnerOs;
  labelPattern: string | null;
  minuteMultiplier: number;
  pricePerMinuteUsd: number;
  /** UTC midnight of the first day the rate applies. */
  effectiveFrom: Date;
};

export const HOSTED_GROUP = "GitHub Actions";

/** Lowercase, de-duplicated, sorted. */
export function normalizeLabels(labels: ReadonlyArray<string>): string[] {
  return [...new Set(labels.map((l) => l.trim().toLowerCase()))]
    .filter((l) => l.length > 0)
    .sort(compareCodeUnits);
}

export function labelKeyOf(labels: ReadonlyArray<string>): string {
  return normalizeLabels(labels).join(",");
}

/** Strips a matrix suffix: "test (ubuntu-latest, 22)" -> "test". */
export function baseNameOf(name: string): string {
  const stripped = stripMatrixSuffix(name).trim();
  return stripped.length > 0 ? stripped : name;
}

/**
 * Same as `name.replace(/\s+\([^()]*\)\s*$/, "")`, without the regex
 * backtracking on long whitespace runs.
 */
function stripMatrixSuffix(name: string): string {
  const end = name.trimEnd();
  if (!end.endsWith(")")) return name;
  const open = end.lastIndexOf("(");
  if (open < 1 || end.lastIndexOf(")", end.length - 2) > open) return name;
  if (!/\s/.test(end[open - 1]!)) return name;
  return end.slice(0, open).trimEnd();
}

const STANDARD_LABEL =
  /^(ubuntu|windows|macos)-(latest|\d+(\.\d+)?)(-(arm|arm64|large|xlarge|intel))?$|^[a-z0-9.-]+-latest$/;

export function isStandardLabel(label: string): boolean {
  return STANDARD_LABEL.test(label);
}

function compile(pattern: string | null): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/**
 * The larger-runner SkuRate whose labelPattern matches one of the labels and
 * whose OS fits the labels (when the labels name an OS).
 */
export function matchLargerSku(
  labels: ReadonlyArray<string>,
  rates: ReadonlyArray<SkuRateLike>,
): SkuRateLike | null {
  const os = runnerOsOf(labels);
  for (const rate of rates) {
    if (os !== "UNKNOWN" && rate.os !== os) continue;
    const re = compile(rate.labelPattern);
    if (re && labels.some((l) => re.test(l))) return rate;
  }
  return null;
}

export type RunnerFacts = {
  labels: ReadonlyArray<string>;
  runnerName: string | null;
  runnerGroupName: string | null;
  /** True when the runner id matches a known self-hosted runner (M2). */
  knownSelfHosted?: boolean;
};

export function classifyRunner(
  facts: RunnerFacts,
  rates: ReadonlyArray<SkuRateLike>,
): RunnerKind {
  const labels = normalizeLabels(facts.labels);
  if (
    labels.includes("self-hosted") ||
    facts.knownSelfHosted ||
    (facts.runnerGroupName != null && facts.runnerGroupName !== HOSTED_GROUP)
  ) {
    return "SELF_HOSTED";
  }
  const hostedRunner =
    facts.runnerGroupName === HOSTED_GROUP ||
    (facts.runnerName != null && /^GitHub Actions \d+$/.test(facts.runnerName));
  const allStandard = labels.length > 0 && labels.every(isStandardLabel);
  if (hostedRunner) {
    if (matchLargerSku(labels, rates) || !allStandard) return "LARGER_HOSTED";
    return "GITHUB_HOSTED";
  }
  if (allStandard) {
    return matchLargerSku(labels, rates) ? "LARGER_HOSTED" : "GITHUB_HOSTED";
  }
  return "UNKNOWN";
}

export function runnerOsOf(
  labels: ReadonlyArray<string>,
  fallback: string | null = null,
): RunnerOs {
  const all = [...normalizeLabels(labels), (fallback ?? "").toLowerCase()];
  if (all.some((l) => /ubuntu|linux/.test(l))) return "LINUX";
  if (all.some((l) => /windows/.test(l))) return "WINDOWS";
  if (all.some((l) => /macos|^mac|osx/.test(l))) return "MACOS";
  return "UNKNOWN";
}

const BASE_SKU: Record<RunnerOs, string | null> = {
  LINUX: "linux",
  WINDOWS: "windows",
  MACOS: "macos",
  UNKNOWN: null,
};

/**
 * The SKU used for cost estimates. Self-hosted and unknown runners have none;
 * a larger runner without a matching SkuRate has none either and is flagged.
 */
export function skuOf(
  kind: RunnerKind,
  os: RunnerOs,
  labels: ReadonlyArray<string>,
  rates: ReadonlyArray<SkuRateLike>,
): string | null {
  if (kind === "SELF_HOSTED" || kind === "UNKNOWN") return null;
  const larger = matchLargerSku(normalizeLabels(labels), rates);
  if (larger) return larger.sku;
  if (kind === "LARGER_HOSTED") return null;
  return BASE_SKU[os];
}

/**
 * "sh:<runnerName>" for self-hosted runners, "pool:<labelKey>" otherwise.
 * Jobs of a repo-level runner get "shr:<repositoryId>:<runnerName>" via
 * {@link jobRunnerKeyResolver}.
 */
export function runnerKeyOf(
  kind: RunnerKind,
  runnerName: string | null,
  labelKey: string,
): string {
  return kind === "SELF_HOSTED" && runnerName
    ? `sh:${runnerName}`
    : `pool:${labelKey}`;
}

export type RunnerScopeRow = {
  scope: "ORG" | "REPO";
  repositoryId: bigint | null;
  name: string;
};

/**
 * DailyRunnerStat / speed-index key of a cached runner. GitHub requires
 * runner names to be unique within one scope only, so two repositories can
 * each have a repo runner with the same name: repo runners are keyed by
 * repository and name ("shr:<repositoryId>:<name>"), org runners by name.
 */
export function runnerStatKey(r: RunnerScopeRow): string {
  return r.scope === "REPO" && r.repositoryId != null
    ? `shr:${r.repositoryId}:${r.name}`
    : `sh:${r.name}`;
}

/** True for a self-hosted runner key ("sh:" or "shr:"). */
export function isSelfHostedKey(key: string): boolean {
  return key.startsWith("sh:") || key.startsWith("shr:");
}

/**
 * Maps a job to its runner key, given the installation's cached runners: a
 * self-hosted job in a repository that has a repo runner of that name
 * belongs to that runner; any other self-hosted job to the org runner (or
 * an unknown runner) of that name; hosted jobs to their label pool.
 */
export function jobRunnerKeyResolver(
  runners: ReadonlyArray<RunnerScopeRow>,
): (job: {
  runnerKind: RunnerKind;
  runnerName: string | null;
  labelKey: string;
  repositoryId: bigint;
}) => string {
  const repoRunners = new Set(
    runners
      .filter((r) => r.scope === "REPO" && r.repositoryId != null)
      .map((r) => `${r.repositoryId}\u0000${r.name}`),
  );
  return (j) =>
    j.runnerKind === "SELF_HOSTED" &&
    j.runnerName &&
    repoRunners.has(`${j.repositoryId}\u0000${j.runnerName}`)
      ? runnerStatKey({
          scope: "REPO",
          repositoryId: j.repositoryId,
          name: j.runnerName,
        })
      : runnerKeyOf(j.runnerKind, j.runnerName, j.labelKey);
}
