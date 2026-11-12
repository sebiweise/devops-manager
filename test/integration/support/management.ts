import { permissionsFor, type TokenPurpose } from "@/server/github/purposes";
import type {
  GhResponse,
  GitHubApi,
  GitHubClients,
} from "@/server/ingest/github-client";

/**
 * An in-memory GitHub for the management integration tests. It enforces what
 * the real API enforces for an installation token, so token narrowing is
 * tested end to end:
 *
 * - a token sees only its installation's repositories (404 otherwise), and a
 *   token narrowed to repository ids only those (403);
 * - every route needs the matching permission level in the token (403);
 * - merging a PR that changes `.github/workflows/` needs `workflows: write`.
 *
 * All names are generic placeholders (example-user, example-org, repo-a).
 */

export type FakeRepo = {
  installationId: bigint;
  id: number;
  owner: string;
  name: string;
};

export type FakeRun = {
  repoId: number;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  attempt: number;
};

export type FakePull = {
  repoId: number;
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  headSha: string;
  files: string[];
  author: string;
  checks: string | null;
  mergeCommitSha?: string;
};

export type Token = {
  installationId: bigint;
  purpose: TokenPurpose;
  permissions: Record<string, string>;
  repoIds: number[] | null;
};

export type Recorded = {
  token: Token | null;
  route: string;
  params: Record<string, unknown>;
};

class GitHubError extends Error {
  readonly response: {
    data: { message: string };
    headers: Record<string, string>;
  };
  constructor(
    readonly status: number,
    message: string,
    requestId: string,
  ) {
    super(message);
    this.response = {
      data: { message },
      headers: { "x-github-request-id": requestId },
    };
  }
}

const LEVEL: Record<string, number> = { read: 1, write: 2 };

export class FakeManagedGitHub {
  readonly repos: FakeRepo[];
  readonly tokens: Token[] = [];
  readonly requests: Recorded[] = [];
  readonly runs = new Map<number, FakeRun>();
  /** repoId -> name -> value */
  readonly variables = new Map<number, Map<string, string>>();
  /** org login -> name -> variable */
  readonly orgVariables = new Map<
    string,
    Map<string, { value: string; visibility: string; selected: number[] }>
  >();
  readonly pulls = new Map<string, FakePull>();
  readonly alerts = new Map<number, Array<Record<string, unknown>>>();
  /** GET /app/installations/{id} answers with these permissions. */
  readonly appPermissions = new Map<bigint, Record<string, string>>();
  /** Status the next write of a repo answers with (failure injection). */
  readonly failWrites = new Map<number, number>();
  private seq = 0;

  constructor(repos: FakeRepo[]) {
    this.repos = repos;
  }

  clients(): GitHubClients {
    return {
      app: () => this.api(null),
      installation: async (installationId, purpose, granted, repoIds) => {
        const permissions = permissionsFor(purpose, granted);
        const token: Token = {
          installationId,
          purpose,
          permissions,
          repoIds: repoIds ? repoIds.map((id) => Number(id)) : null,
        };
        this.tokens.push(token);
        return this.api(token);
      },
    };
  }

  /** Mutating requests (everything except GET and GraphQL reads). */
  writes(): Recorded[] {
    return this.requests.filter(
      (r) => !r.route.startsWith("GET ") && r.route !== "POST /graphql",
    );
  }

  setVariable(repoId: number, name: string, value: string) {
    const vars = this.variables.get(repoId) ?? new Map<string, string>();
    vars.set(name, value);
    this.variables.set(repoId, vars);
  }

  variable(repoId: number, name: string): string | null {
    return this.variables.get(repoId)?.get(name) ?? null;
  }

  addPull(pull: Partial<FakePull> & { repoId: number; number: number }) {
    const full: FakePull = {
      title: `Update dependency ${pull.number}`,
      state: "open",
      draft: false,
      merged: false,
      mergeable: true,
      mergeableState: "clean",
      headSha: "b".repeat(40),
      files: ["package.json"],
      author: "dependabot[bot]",
      checks: "SUCCESS",
      ...pull,
    };
    this.pulls.set(`${pull.repoId}#${pull.number}`, full);
    return full;
  }

  private fail(status: number, message: string): never {
    throw new GitHubError(status, message, `REQ-${++this.seq}`);
  }

  private ok<T>(data: T, status = 200): GhResponse<T> {
    return {
      status,
      data,
      headers: { "x-github-request-id": `REQ-${++this.seq}` },
    };
  }

  private need(token: Token | null, name: string, level: "read" | "write") {
    if (!token) this.fail(401, "Bad credentials");
    const have = token.permissions[name];
    if (!have || LEVEL[have]! < LEVEL[level]!)
      this.fail(403, "Resource not accessible by integration");
  }

  private repoOf(token: Token | null, params: Record<string, unknown>) {
    if (!token) this.fail(401, "Bad credentials");
    const repo = this.repos.find(
      (r) =>
        r.installationId === token.installationId &&
        r.owner === params.owner &&
        r.name === params.repo,
    );
    if (!repo) this.fail(404, "Not Found");
    if (token.repoIds && !token.repoIds.includes(repo.id))
      this.fail(403, "Resource not accessible by integration");
    return repo;
  }

  private orgOf(token: Token | null, params: Record<string, unknown>) {
    if (!token) this.fail(401, "Bad credentials");
    const own = this.repos.find(
      (r) => r.installationId === token.installationId,
    );
    if (!own || own.owner !== params.org) this.fail(404, "Not Found");
    const vars =
      this.orgVariables.get(String(params.org)) ??
      new Map<
        string,
        { value: string; visibility: string; selected: number[] }
      >();
    this.orgVariables.set(String(params.org), vars);
    return vars;
  }

  api(token: Token | null): GitHubApi {
    return {
      request: async <T>(
        route: string,
        params: Record<string, unknown> = {},
      ) => {
        this.requests.push({ token, route, params });
        return this.route(token, route, params) as GhResponse<T>;
      },
    };
  }

  private route(
    token: Token | null,
    route: string,
    p: Record<string, unknown>,
  ): GhResponse<unknown> {
    const runRoute = route.match(
      /^POST \/repos\/\{owner\}\/\{repo\}\/actions\/runs\/\{run_id\}\/(rerun|rerun-failed-jobs|cancel|force-cancel)$/,
    );
    if (runRoute) {
      const repo = this.repoOf(token, p);
      this.need(token, "actions", "write");
      const run = this.runs.get(Number(p.run_id));
      if (!run || run.repoId !== repo.id) this.fail(404, "Not Found");
      const op = runRoute[1];
      if (op === "rerun" || op === "rerun-failed-jobs") {
        if (run.status !== "completed")
          this.fail(403, "This workflow is already running");
        run.attempt++;
        run.status = "queued";
        run.conclusion = null;
        return this.ok({}, 201);
      }
      if (run.status === "completed")
        this.fail(409, "Cannot cancel a workflow run that is completed.");
      if (op === "force-cancel") {
        run.status = "completed";
        run.conclusion = "cancelled";
      }
      // A plain cancel is requested; the run stays in progress (stuck runner).
      return this.ok({}, 202);
    }

    switch (route) {
      case "GET /app/installations/{installation_id}": {
        if (token) this.fail(401, "A JSON web token could not be decoded");
        const perms = this.appPermissions.get(
          BigInt(Number(p.installation_id)),
        );
        if (!perms) this.fail(404, "Not Found");
        return this.ok({ id: Number(p.installation_id), permissions: perms });
      }
      case "GET /repos/{owner}/{repo}/actions/runs/{run_id}": {
        const repo = this.repoOf(token, p);
        this.need(token, "actions", "read");
        const run = this.runs.get(Number(p.run_id));
        if (!run || run.repoId !== repo.id) this.fail(404, "Not Found");
        return this.ok({
          id: Number(p.run_id),
          status: run.status,
          conclusion: run.conclusion,
          run_attempt: run.attempt,
        });
      }
      case "GET /repos/{owner}/{repo}/actions/variables": {
        const repo = this.repoOf(token, p);
        this.need(token, "actions_variables", "read");
        const all = [...(this.variables.get(repo.id) ?? new Map()).entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([name, value]) => ({
            name,
            value,
            updated_at: "2026-11-01T00:00:00Z",
          }));
        const perPage = Number(p.per_page ?? 30);
        const page = Number(p.page ?? 1);
        return this.ok({
          total_count: all.length,
          variables: all.slice((page - 1) * perPage, page * perPage),
        });
      }
      case "GET /repos/{owner}/{repo}/actions/variables/{name}": {
        const repo = this.repoOf(token, p);
        this.need(token, "actions_variables", "read");
        const value = this.variable(repo.id, String(p.name));
        if (value === null) this.fail(404, "Not Found");
        return this.ok({ name: p.name, value });
      }
      case "POST /repos/{owner}/{repo}/actions/variables": {
        const repo = this.repoOf(token, p);
        this.need(token, "actions_variables", "write");
        this.injected(repo.id);
        if (this.variable(repo.id, String(p.name)) !== null)
          this.fail(409, "Already exists - Variable already exists");
        this.setVariable(repo.id, String(p.name), String(p.value));
        return this.ok({}, 201);
      }
      case "PATCH /repos/{owner}/{repo}/actions/variables/{name}": {
        const repo = this.repoOf(token, p);
        this.need(token, "actions_variables", "write");
        this.injected(repo.id);
        if (this.variable(repo.id, String(p.name)) === null)
          this.fail(404, "Not Found");
        this.setVariable(repo.id, String(p.name), String(p.value));
        return this.ok(null, 204);
      }
      case "DELETE /repos/{owner}/{repo}/actions/variables/{name}": {
        const repo = this.repoOf(token, p);
        this.need(token, "actions_variables", "write");
        this.injected(repo.id);
        if (!this.variables.get(repo.id)?.delete(String(p.name)))
          this.fail(404, "Not Found");
        return this.ok(null, 204);
      }
      case "GET /orgs/{org}/actions/variables": {
        const vars = this.orgOf(token, p);
        this.need(token, "organization_actions_variables", "read");
        const list = [...vars.entries()].map(([name, v]) => ({
          name,
          value: v.value,
          visibility: v.visibility,
        }));
        return this.ok({ total_count: list.length, variables: list });
      }
      case "GET /orgs/{org}/actions/variables/{name}": {
        const vars = this.orgOf(token, p);
        this.need(token, "organization_actions_variables", "read");
        const v = vars.get(String(p.name));
        if (!v) this.fail(404, "Not Found");
        return this.ok({
          name: p.name,
          value: v.value,
          visibility: v.visibility,
        });
      }
      case "GET /orgs/{org}/actions/variables/{name}/repositories": {
        const vars = this.orgOf(token, p);
        this.need(token, "organization_actions_variables", "read");
        const v = vars.get(String(p.name));
        if (!v) this.fail(404, "Not Found");
        return this.ok({
          total_count: v.selected.length,
          repositories: v.selected.map((id) => ({ id })),
        });
      }
      case "POST /orgs/{org}/actions/variables":
      case "PATCH /orgs/{org}/actions/variables/{name}": {
        const vars = this.orgOf(token, p);
        this.need(token, "organization_actions_variables", "write");
        const exists = vars.has(String(p.name));
        if (route.startsWith("POST") && exists)
          this.fail(409, "Already exists");
        if (route.startsWith("PATCH") && !exists) this.fail(404, "Not Found");
        vars.set(String(p.name), {
          value: String(p.value),
          visibility: String(p.visibility),
          selected: ((p.selected_repository_ids as number[]) ?? []).slice(),
        });
        return this.ok(null, route.startsWith("POST") ? 201 : 204);
      }
      case "DELETE /orgs/{org}/actions/variables/{name}": {
        const vars = this.orgOf(token, p);
        this.need(token, "organization_actions_variables", "write");
        if (!vars.delete(String(p.name))) this.fail(404, "Not Found");
        return this.ok(null, 204);
      }
      case "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        const repo = this.repoOf(token, p);
        this.need(token, "pull_requests", "read");
        const pr = this.pulls.get(`${repo.id}#${Number(p.pull_number)}`);
        if (!pr) this.fail(404, "Not Found");
        return this.ok({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: pr.draft,
          merged: pr.merged,
          mergeable: pr.mergeable,
          mergeable_state: pr.mergeableState,
          merge_commit_sha: pr.mergeCommitSha ?? null,
          head: { sha: pr.headSha },
        });
      }
      case "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": {
        const repo = this.repoOf(token, p);
        this.need(token, "pull_requests", "read");
        const pr = this.pulls.get(`${repo.id}#${Number(p.pull_number)}`);
        if (!pr) this.fail(404, "Not Found");
        const perPage = Number(p.per_page ?? 30);
        const page = Number(p.page ?? 1);
        return this.ok(
          pr.files
            .slice((page - 1) * perPage, page * perPage)
            .map((filename) => ({ filename })),
        );
      }
      case "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge": {
        const repo = this.repoOf(token, p);
        this.need(token, "contents", "write");
        this.need(token, "pull_requests", "write");
        const pr = this.pulls.get(`${repo.id}#${Number(p.pull_number)}`);
        if (!pr) this.fail(404, "Not Found");
        if (pr.files.some((f) => f.startsWith(".github/workflows/")))
          this.need(token, "workflows", "write");
        if (!pr.mergeable || pr.state !== "open")
          this.fail(405, "Pull Request is not mergeable");
        if (p.sha !== pr.headSha)
          this.fail(
            409,
            "Head branch was modified. Review and try the merge again.",
          );
        pr.merged = true;
        pr.state = "closed";
        pr.mergeCommitSha = "c".repeat(40);
        return this.ok({
          merged: true,
          sha: pr.mergeCommitSha,
          message: "Pull Request successfully merged",
        });
      }
      case "POST /graphql":
        return this.graphql(token, p);
      case "GET /repos/{owner}/{repo}/dependabot/alerts": {
        const repo = this.repoOf(token, p);
        this.need(token, "vulnerability_alerts", "read");
        const list = this.alerts.get(repo.id);
        if (!list)
          this.fail(403, "Dependabot alerts are disabled for this repository.");
        return this.ok(list);
      }
      default:
        this.fail(404, `Unexpected route ${route}`);
    }
  }

  private injected(repoId: number) {
    const status = this.failWrites.get(repoId);
    if (status) {
      this.failWrites.delete(repoId);
      this.fail(status, "Server Error");
    }
  }

  private graphql(token: Token | null, p: Record<string, unknown>) {
    this.need(token, "pull_requests", "read");
    const vars = (p.variables ?? {}) as Record<string, string>;
    const data: Record<string, unknown> = {};
    for (let i = 0; `o${i}` in vars; i++) {
      let repo: FakeRepo;
      try {
        repo = this.repoOf(token, {
          owner: vars[`o${i}`],
          repo: vars[`n${i}`],
        });
      } catch {
        data[`r${i}`] = null;
        continue;
      }
      const prs = [...this.pulls.values()].filter(
        (pr) => pr.repoId === repo.id && pr.state === "open",
      );
      data[`r${i}`] = {
        mergeCommitAllowed: true,
        squashMergeAllowed: true,
        rebaseMergeAllowed: false,
        pullRequests: {
          totalCount: prs.length,
          nodes: prs.map((pr) => ({
            number: pr.number,
            title: pr.title,
            url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
            isDraft: pr.draft,
            createdAt: `2026-11-0${(pr.number % 9) + 1}T00:00:00Z`,
            headRefOid: pr.headSha,
            headRefName: `dependabot/npm/${pr.number}`,
            baseRefName: "main",
            mergeable:
              pr.mergeable === null
                ? "UNKNOWN"
                : pr.mergeable
                  ? "MERGEABLE"
                  : "CONFLICTING",
            mergeStateStatus: pr.mergeableState.toUpperCase(),
            reviewDecision: null,
            author: { login: pr.author.replace(/\[bot\]$/, "") },
            labels: { nodes: [{ name: "dependencies" }] },
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: pr.checks ? { state: pr.checks } : null,
                  },
                },
              ],
            },
            files: {
              totalCount: pr.files.length,
              nodes: pr.files.slice(0, 100).map((path) => ({ path })),
            },
          })),
        },
      };
    }
    return this.ok({ data });
  }
}
