/**
 * The semver update type of a Dependabot pull request, for the guarded bulk
 * merge (design §8.2 #10): only patch and minor updates qualify.
 *
 * Dependabot writes the update type of every dependency into its commit
 * message (`update-type: version-update:semver-minor`); a grouped update
 * counts as its largest member. Without that metadata (the PR list has only
 * the title) the versions of a "Bump x from 1.2.3 to 1.3.0" title decide.
 * Anything else is unknown and does not qualify.
 */

export type UpdateType = "patch" | "minor" | "major";

const RANK: Record<UpdateType, number> = { patch: 0, minor: 1, major: 2 };

function largest(types: UpdateType[]): UpdateType | null {
  if (types.length === 0) return null;
  return types.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}

/** From Dependabot's commit metadata; null when it has none. */
export function updateTypeFromCommit(message: string): UpdateType | null {
  const types: UpdateType[] = [];
  let unknown = false;
  for (const m of message.matchAll(/^\s*update-type:\s*(\S+)\s*$/gim)) {
    const t = /^version-update:semver-(patch|minor|major)$/i.exec(m[1]!);
    if (t) types.push(t[1]!.toLowerCase() as UpdateType);
    else unknown = true;
  }
  // An entry we cannot classify makes the whole update count as major.
  if (unknown) return "major";
  return largest(types);
}

const VERSION = String.raw`v?(\d+)(?:\.(\d+))?(?:\.(\d+))?[^\s]*`;
const FROM_TO = new RegExp(
  String.raw`\bfrom\s+${VERSION}\s+to\s+${VERSION}`,
  "i",
);

/** From a "Bump x from 1.2.3 to 1.2.4" title; null when it has no versions. */
export function updateTypeFromTitle(title: string): UpdateType | null {
  const m = FROM_TO.exec(title);
  if (!m) return null;
  const [from, to] = [m.slice(1, 4), m.slice(4, 7)].map((parts) =>
    parts.map((p) => Number(p ?? 0)),
  );
  if (from![0] !== to![0]) return "major";
  if (from![1] !== to![1]) return "minor";
  return "patch";
}

/** Commit metadata first, then the title. */
export function dependabotUpdateType(
  title: string,
  commitMessages: readonly string[] = [],
): UpdateType | null {
  const fromCommits = largest(
    commitMessages
      .map(updateTypeFromCommit)
      .filter((t): t is UpdateType => t !== null),
  );
  return fromCommits ?? updateTypeFromTitle(title);
}

export function isPatchOrMinor(type: UpdateType | null): boolean {
  return type === "patch" || type === "minor";
}
