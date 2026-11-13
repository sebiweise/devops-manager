/**
 * Token purposes (design §3.4). Each purpose maps to the narrowest permission
 * set it needs; the token broker requests exactly that set, so an installation
 * token minted for reading cannot write, and a merge token only carries
 * `workflows: write` when the PR actually changes workflow files.
 *
 * Optional permissions (marked below) are requested only when the
 * installation has granted them; requesting an ungranted permission makes
 * GitHub refuse the whole token.
 */

export type Permission = "read" | "write";
export type PermissionSet = Record<string, Permission>;

export type TokenPurpose =
  | "sync.inventory"
  | "sync.runs"
  | "sync.runners"
  | "sync.billing"
  | "read.pulls"
  | "read.variables"
  | "read.org_variables"
  | "read.dependabot"
  | "read.deployments"
  | "read.checks"
  | "act.runs"
  | "act.variables"
  | "act.org_variables"
  | "act.merge"
  | "act.merge.workflows";

type PurposeSpec = {
  required: PermissionSet;
  /** Requested only when granted to the installation. */
  optional?: PermissionSet;
  /** Mutation tokens: never cached, always narrowed to the target repos. */
  mutation?: boolean;
};

export const PURPOSES: Record<TokenPurpose, PurposeSpec> = {
  "sync.inventory": { required: { metadata: "read" } },
  "sync.runs": { required: { metadata: "read", actions: "read" } },
  "sync.runners": {
    required: {},
    optional: {
      organization_self_hosted_runners: "read",
      administration: "read",
    },
  },
  "sync.billing": { required: { organization_administration: "read" } },
  "read.pulls": {
    required: { pull_requests: "read", contents: "read" },
    optional: { checks: "read", statuses: "read" },
  },
  "read.variables": {
    required: { actions_variables: "read" },
    optional: { organization_actions_variables: "read" },
  },
  "read.org_variables": {
    required: { organization_actions_variables: "read" },
  },
  "read.dependabot": { required: { vulnerability_alerts: "read" } },
  // Optional (addendum §7.3): only gates the deployment_status hint fold,
  // which needs no token; without it the hints are simply inactive.
  "read.deployments": { required: { deployments: "read" } },
  // Optional (addendum M7 §4.4): only gates the check_run hint fold of Azure
  // Pipelines, which needs no token; without it polling still converges.
  "read.checks": { required: { checks: "read" } },
  "act.runs": { required: { actions: "write" }, mutation: true },
  "act.variables": { required: { actions_variables: "write" }, mutation: true },
  "act.org_variables": {
    required: { organization_actions_variables: "write" },
    mutation: true,
  },
  "act.merge": {
    required: { contents: "write", pull_requests: "write" },
    mutation: true,
  },
  "act.merge.workflows": {
    required: { contents: "write", pull_requests: "write", workflows: "write" },
    mutation: true,
  },
};

const LEVEL: Record<Permission, number> = { read: 1, write: 2 };

function grants(
  granted: Record<string, unknown>,
  name: string,
  level: Permission,
): boolean {
  const have = granted[name];
  return (have === "read" || have === "write") && LEVEL[have] >= LEVEL[level];
}

export class PermissionNotGrantedError extends Error {
  constructor(
    readonly purpose: TokenPurpose,
    readonly missing: string[],
  ) {
    super(`The GitHub App installation has not granted: ${missing.join(", ")}`);
    this.name = "PermissionNotGrantedError";
  }
}

/**
 * The permission set to request for `purpose`, given what the installation has
 * granted. Throws `PermissionNotGrantedError` when a required permission is
 * missing (the caller shows the "permission not granted" explainer), and when
 * the resulting set would be empty: GitHub treats an empty `permissions`
 * object as "no narrowing" and mints a token with every installation
 * permission, so an empty set must never reach the token endpoint.
 */
export function permissionsFor(
  purpose: TokenPurpose,
  granted: Record<string, unknown>,
): PermissionSet {
  const spec = PURPOSES[purpose];
  const missing = Object.entries(spec.required)
    .filter(([name, level]) => !grants(granted, name, level))
    .map(([name, level]) => `${name}:${level}`);
  if (missing.length > 0) throw new PermissionNotGrantedError(purpose, missing);

  const out: PermissionSet = { ...spec.required };
  for (const [name, level] of Object.entries(spec.optional ?? {})) {
    if (grants(granted, name, level)) out[name] = level;
  }
  if (Object.keys(out).length === 0) {
    throw new PermissionNotGrantedError(
      purpose,
      Object.entries(spec.optional ?? {}).map(
        ([name, level]) => `${name}:${level}`,
      ),
    );
  }
  return out;
}

export function isMutationPurpose(purpose: TokenPurpose): boolean {
  return PURPOSES[purpose].mutation === true;
}

/** The merge purpose for a PR, from its changed file paths. */
export function mergePurposeFor(changedFiles: readonly string[]): TokenPurpose {
  return changedFiles.some((f) => f.startsWith(".github/workflows/"))
    ? "act.merge.workflows"
    : "act.merge";
}

/** The permissions `purpose` lacks on an installation, or null when granted. */
export function missingOf(
  purpose: TokenPurpose,
  granted: Record<string, unknown>,
): string[] | null {
  try {
    permissionsFor(purpose, granted);
    return null;
  } catch (error) {
    if (error instanceof PermissionNotGrantedError) return error.missing;
    throw error;
  }
}
