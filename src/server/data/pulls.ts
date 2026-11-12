import "server-only";
import { storeRepoCounts } from "@/server/ingest/repo-counts";
import { LRUCache } from "lru-cache";
import { mapLimit } from "@/lib/concurrency";
import type { TenantScope } from "@/server/authz/scope";
import { missingOf } from "@/server/github/purposes";
import type { MergeMethod } from "@/server/github/rest";
import type { GitHubApi, GitHubClients } from "@/server/ingest/github-client";
import { githubClients } from "@/server/ingest/triggers";
import {
  findInstallationAccount,
  listRepoTargets,
  type RepoTarget,
} from "./management";

/**
 * Open pull requests across the repos of an installation (design §7
 * /pulls): checks rollup, mergeable state, review decision, the Dependabot,
 * draft and "changes workflows" chips. Read live through GraphQL with a
 * `read.pulls` token narrowed to the installation's repos, ten repos per
 * query, and cached for 60 s; a merge drops the cache. PR bodies are never
 * fetched; titles are rendered as text only.
 */

export type PullRow = {
  repositoryId: string;
  repoFullName: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  isDependabot: boolean;
  isDraft: boolean;
  createdAt: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT or UNKNOWN. */
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  /** SUCCESS, FAILURE, ERROR, PENDING, EXPECTED; null = no checks. */
  checks: string | null;
  /** True/false from the first 100 changed files; null when the PR has more. */
  changesWorkflows: boolean | null;
  labels: string[];
};

export type PullRepo = {
  repositoryId: string;
  fullName: string;
  status: "ok" | "unavailable";
  mergeMethods: MergeMethod[];
  /** More open PRs than listed (50 per repo). */
  truncated: boolean;
};

export type PullOverview =
  | {
      status: "ok";
      pulls: PullRow[];
      repos: PullRepo[];
      /** Workflow-changing PRs need `Workflows: write` to be merged. */
      workflowsGranted: boolean;
      /** More active repos than the overview covers. */
      truncated: boolean;
    }
  | { status: "no_permission"; missing: string[] };

const MAX_REPOS = 200;
const REPOS_PER_QUERY = 10;
const PRS_PER_REPO = 50;
const TTL_MS = 60_000;

const REPO_FIELDS = `
  mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
  pullRequests(states: OPEN, first: ${PRS_PER_REPO}, orderBy: {field: CREATED_AT, direction: DESC}) {
    totalCount
    nodes {
      number title url isDraft createdAt headRefOid headRefName baseRefName
      mergeable mergeStateStatus reviewDecision
      author { login }
      labels(first: 10) { nodes { name } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      files(first: 100) { totalCount nodes { path } }
    }
  }`;

/** The aliased GraphQL query for a chunk of repos (exported for tests). */
export function pullsQuery(count: number): string {
  const vars = Array.from(
    { length: count },
    (_, i) => `$o${i}: String!, $n${i}: String!`,
  ).join(", ");
  const repos = Array.from(
    { length: count },
    (_, i) => `r${i}: repository(owner: $o${i}, name: $n${i}) {${REPO_FIELDS}}`,
  ).join("\n");
  return `query(${vars}) {\n${repos}\n}`;
}

type GqlPull = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  mergeable: PullRow["mergeable"];
  mergeStateStatus?: string | null;
  reviewDecision?: string | null;
  author?: { login: string } | null;
  labels?: { nodes: Array<{ name: string }> };
  commits?: {
    nodes: Array<{
      commit: { statusCheckRollup?: { state: string } | null };
    }>;
  };
  files?: { totalCount: number; nodes: Array<{ path: string }> } | null;
};

type GqlRepo = {
  mergeCommitAllowed: boolean;
  squashMergeAllowed: boolean;
  rebaseMergeAllowed: boolean;
  pullRequests: { totalCount: number; nodes: GqlPull[] };
} | null;

const isDependabotLogin = (login: string | null | undefined) =>
  !!login && /^dependabot(\[bot\])?$/i.test(login);

export function mapPull(repo: RepoTarget, p: GqlPull): PullRow {
  const files = p.files?.nodes.map((f) => f.path) ?? [];
  const touches = files.some((f) => f.startsWith(".github/workflows/"));
  return {
    repositoryId: String(repo.id),
    repoFullName: repo.fullName,
    number: p.number,
    title: p.title,
    url: p.url,
    author: p.author?.login ?? null,
    isDependabot: isDependabotLogin(p.author?.login),
    isDraft: p.isDraft,
    createdAt: p.createdAt,
    headSha: p.headRefOid,
    headRef: p.headRefName,
    baseRef: p.baseRefName,
    mergeable: p.mergeable,
    mergeStateStatus: p.mergeStateStatus ?? null,
    reviewDecision: p.reviewDecision ?? null,
    checks: p.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    changesWorkflows: touches
      ? true
      : (p.files?.totalCount ?? 0) > files.length
        ? null
        : false,
    labels: p.labels?.nodes.map((l) => l.name) ?? [],
  };
}

type Loaded = { pulls: PullRow[]; repos: PullRepo[]; truncated: boolean };

const cache = new LRUCache<string, Promise<Loaded>>({ max: 200, ttl: TTL_MS });

export function forgetPulls(installationId: bigint): void {
  cache.delete(String(installationId));
}

export function resetPullsCache(): void {
  cache.clear();
}

export async function listOpenPulls(
  scope: TenantScope,
  installationId: bigint,
  clients: GitHubClients = githubClients,
): Promise<PullOverview> {
  const inst = await findInstallationAccount(scope, installationId);
  const missing = missingOf("read.pulls", inst.permissions);
  if (missing) return { status: "no_permission", missing };
  const repos = await listRepoTargets(scope, installationId);
  const key = String(installationId);
  let pending = cache.get(key);
  if (!pending) {
    pending = loadPulls(inst, repos, clients);
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  const loaded = await pending;
  return {
    status: "ok",
    ...loaded,
    workflowsGranted: !missingOf("act.merge.workflows", inst.permissions),
  };
}

async function loadPulls(
  inst: { id: bigint; permissions: Record<string, unknown> },
  allRepos: RepoTarget[],
  clients: GitHubClients,
): Promise<Loaded> {
  const repos = allRepos.filter((r) => !r.archived).slice(0, MAX_REPOS);
  if (repos.length === 0) return { pulls: [], repos: [], truncated: false };
  const api = await clients.installation(
    inst.id,
    "read.pulls",
    inst.permissions,
    repos.map((r) => r.id),
  );
  const chunks: RepoTarget[][] = [];
  for (let i = 0; i < repos.length; i += REPOS_PER_QUERY)
    chunks.push(repos.slice(i, i + REPOS_PER_QUERY));
  const results = await mapLimit(chunks, 2, (chunk) => queryChunk(api, chunk));
  const pulls = results.flatMap((r) => r.pulls);
  pulls.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  // The live read also refreshes the cached counts of the repositories table.
  await storeRepoCounts(
    inst.id,
    results
      .flatMap((r) => r.counts)
      .map((c) => ({ repositoryId: c.repositoryId, openPrCount: c.open })),
  ).catch(() => undefined);
  return {
    pulls,
    repos: results.flatMap((r) => r.repos),
    truncated: allRepos.filter((r) => !r.archived).length > repos.length,
  };
}

/**
 * One repository's open PRs and allowed merge methods, read live (not
 * cached): the re-check before each merge of the Dependabot bulk merge.
 */
export async function readRepoPulls(
  api: GitHubApi,
  repo: RepoTarget,
): Promise<{ pulls: PullRow[]; repo: PullRepo }> {
  const { pulls, repos } = await queryChunk(api, [repo]);
  return { pulls, repo: repos[0]! };
}

async function queryChunk(
  api: GitHubApi,
  chunk: RepoTarget[],
): Promise<{
  pulls: PullRow[];
  repos: PullRepo[];
  counts: Array<{ repositoryId: bigint; open: number }>;
}> {
  const variables: Record<string, string> = {};
  chunk.forEach((r, i) => {
    variables[`o${i}`] = r.ownerLogin;
    variables[`n${i}`] = r.name;
  });
  let data: Record<string, GqlRepo> = {};
  try {
    const res = await api.request<{ data?: Record<string, GqlRepo> }>(
      "POST /graphql",
      { query: pullsQuery(chunk.length), variables },
    );
    data = res.data.data ?? {};
  } catch {
    data = {};
  }
  const pulls: PullRow[] = [];
  const counts: Array<{ repositoryId: bigint; open: number }> = [];
  const repos: PullRepo[] = chunk.map((repo, i) => {
    const r = data[`r${i}`];
    if (r)
      counts.push({ repositoryId: repo.id, open: r.pullRequests.totalCount });
    if (!r)
      return {
        repositoryId: String(repo.id),
        fullName: repo.fullName,
        status: "unavailable",
        mergeMethods: [],
        truncated: false,
      };
    for (const p of r.pullRequests.nodes) pulls.push(mapPull(repo, p));
    const methods: MergeMethod[] = [];
    if (r.mergeCommitAllowed) methods.push("merge");
    if (r.squashMergeAllowed) methods.push("squash");
    if (r.rebaseMergeAllowed) methods.push("rebase");
    return {
      repositoryId: String(repo.id),
      fullName: repo.fullName,
      status: "ok",
      mergeMethods: methods,
      truncated: r.pullRequests.totalCount > r.pullRequests.nodes.length,
    };
  });
  return { pulls, repos, counts };
}
