import "server-only";
import { storeRepoCounts } from "@/server/ingest/repo-counts";
import { LRUCache } from "lru-cache";
import { mapLimit } from "@/lib/concurrency";
import type { TenantScope } from "@/server/authz/scope";
import { githubErrorInfo } from "@/server/github/errors";
import { missingOf } from "@/server/github/purposes";
import {
  nextLink,
  type GitHubApi,
  type GitHubClients,
} from "@/server/ingest/github-client";
import { githubClients } from "@/server/ingest/triggers";
import {
  findInstallationAccount,
  listRepoTargets,
  type RepoTarget,
} from "./management";

/**
 * Open Dependabot alerts across the repos of an installation (design §7
 * /dependabot). Read-only: alerts are never dismissed (non-goal). Read live
 * with a `read.dependabot` token (Dependabot alerts: read) narrowed to the
 * installation's repos, and cached for five minutes.
 */

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type AlertRow = {
  repositoryId: string;
  repoFullName: string;
  number: number;
  severity: Severity;
  packageName: string | null;
  ecosystem: string | null;
  manifestPath: string | null;
  ghsaId: string | null;
  cveId: string | null;
  summary: string | null;
  /** First patched version, if one exists. */
  fixedIn: string | null;
  htmlUrl: string | null;
  createdAt: string | null;
};

export type AlertRepo = {
  repositoryId: string;
  fullName: string;
  /** "disabled": Dependabot alerts are off for the repo (GitHub answers 403). */
  status: "ok" | "disabled" | "unavailable";
  counts: Record<Severity, number>;
};

export type DependabotOverview =
  | {
      status: "ok";
      alerts: AlertRow[];
      repos: AlertRepo[];
      totals: Record<Severity, number>;
      truncated: boolean;
    }
  | { status: "no_permission"; missing: string[] };

const MAX_REPOS = 200;
const MAX_PAGES = 3;
const TTL_MS = 5 * 60_000;

type GhAlert = {
  number: number;
  html_url?: string;
  created_at?: string;
  dependency?: {
    package?: { name?: string; ecosystem?: string };
    manifest_path?: string;
  };
  security_advisory?: {
    ghsa_id?: string;
    cve_id?: string | null;
    summary?: string;
    severity?: string;
  };
  security_vulnerability?: {
    severity?: string;
    first_patched_version?: { identifier?: string } | null;
  };
};

const zero = (): Record<Severity, number> => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
});

function severityOf(a: GhAlert): Severity {
  const s = (
    a.security_vulnerability?.severity ??
    a.security_advisory?.severity ??
    "low"
  ).toLowerCase();
  return (SEVERITIES as readonly string[]).includes(s)
    ? (s as Severity)
    : "low";
}

export function mapAlert(repo: RepoTarget, a: GhAlert): AlertRow {
  return {
    repositoryId: String(repo.id),
    repoFullName: repo.fullName,
    number: a.number,
    severity: severityOf(a),
    packageName: a.dependency?.package?.name ?? null,
    ecosystem: a.dependency?.package?.ecosystem ?? null,
    manifestPath: a.dependency?.manifest_path ?? null,
    ghsaId: a.security_advisory?.ghsa_id ?? null,
    cveId: a.security_advisory?.cve_id ?? null,
    summary: a.security_advisory?.summary ?? null,
    fixedIn:
      a.security_vulnerability?.first_patched_version?.identifier ?? null,
    htmlUrl: a.html_url ?? null,
    createdAt: a.created_at ?? null,
  };
}

type Loaded = Omit<Extract<DependabotOverview, { status: "ok" }>, "status">;

const cache = new LRUCache<string, Promise<Loaded>>({ max: 200, ttl: TTL_MS });

export function resetDependabotCache(): void {
  cache.clear();
}

export async function listDependabotAlerts(
  scope: TenantScope,
  installationId: bigint,
  clients: GitHubClients = githubClients,
): Promise<DependabotOverview> {
  const inst = await findInstallationAccount(scope, installationId);
  const missing = missingOf("read.dependabot", inst.permissions);
  if (missing) return { status: "no_permission", missing };
  const repos = await listRepoTargets(scope, installationId);
  const key = String(installationId);
  let pending = cache.get(key);
  if (!pending) {
    pending = loadAlerts(inst, repos, clients);
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  return { status: "ok", ...(await pending) };
}

/** The `after` cursor of the next page, or null on the last page. */
export function afterCursor(
  headers: Record<string, string | number | undefined>,
): string | null {
  const next = nextLink(headers);
  if (!next) return null;
  try {
    return new URL(next).searchParams.get("after") || null;
  } catch {
    return null;
  }
}

async function repoAlerts(
  api: GitHubApi,
  repo: RepoTarget,
): Promise<{ status: AlertRepo["status"]; alerts: AlertRow[] }> {
  const alerts: AlertRow[] = [];
  try {
    // This endpoint pages with cursors only (`after` from the Link header's
    // rel="next"); it has no `page` parameter.
    let after: string | null = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await api.request<GhAlert[]>(
        "GET /repos/{owner}/{repo}/dependabot/alerts",
        {
          owner: repo.ownerLogin,
          repo: repo.name,
          state: "open",
          per_page: 100,
          ...(after ? { after } : {}),
        },
      );
      alerts.push(...res.data.map((a) => mapAlert(repo, a)));
      after = afterCursor(res.headers);
      if (!after) break;
    }
    return { status: "ok", alerts };
  } catch (error) {
    const status = githubErrorInfo(error).status;
    return { status: status === 403 ? "disabled" : "unavailable", alerts: [] };
  }
}

async function loadAlerts(
  inst: { id: bigint; permissions: Record<string, unknown> },
  allRepos: RepoTarget[],
  clients: GitHubClients,
): Promise<Loaded> {
  const repos = allRepos.filter((r) => !r.archived).slice(0, MAX_REPOS);
  const totals = zero();
  if (repos.length === 0)
    return { alerts: [], repos: [], totals, truncated: false };
  const api = await clients.installation(
    inst.id,
    "read.dependabot",
    inst.permissions,
    repos.map((r) => r.id),
  );
  const results = await mapLimit(repos, 4, (repo) => repoAlerts(api, repo));
  const alerts: AlertRow[] = [];
  const rows: AlertRepo[] = repos.map((repo, i) => {
    const r = results[i]!;
    const counts = zero();
    for (const a of r.alerts) {
      counts[a.severity]++;
      totals[a.severity]++;
      alerts.push(a);
    }
    return {
      repositoryId: String(repo.id),
      fullName: repo.fullName,
      status: r.status,
      counts,
    };
  });
  // The live read also refreshes the cached counts of the repositories table.
  await storeRepoCounts(
    inst.id,
    rows
      .filter((r) => r.status === "ok")
      .map((r) => ({
        repositoryId: BigInt(r.repositoryId),
        openAlertCount: SEVERITIES.reduce((s, k) => s + r.counts[k], 0),
        openAlertHighCount: r.counts.critical + r.counts.high,
      })),
  ).catch(() => undefined);
  const rank = (s: Severity) => SEVERITIES.indexOf(s);
  alerts.sort(
    (a, b) =>
      rank(a.severity) - rank(b.severity) ||
      a.repoFullName.localeCompare(b.repoFullName) ||
      a.number - b.number,
  );
  return {
    alerts,
    repos: rows,
    totals,
    truncated: allRepos.filter((r) => !r.archived).length > repos.length,
  };
}
