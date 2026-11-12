import type * as DbModule from "@/server/db";
import type { GhWorkflowJob, GhWorkflowRun } from "@/server/ingest/github-map";
import type {
  GhResponse,
  GitHubApi,
  GitHubClients,
} from "@/server/ingest/github-client";

/**
 * Shared setup for the Actions integration tests: environment, table reset,
 * synthetic GitHub data and an in-memory GitHub API. All names are generic
 * placeholders (example-user, example-org, repo-a, runner-1).
 */

export const DATABASE_URL = process.env.TEST_DATABASE_URL;
export const WEBHOOK_SECRET = "integration-webhook-secret";

export function setActionsEnv(extra: Record<string, string> = {}) {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL,
    BETTER_AUTH_SECRET: "integration-secret-integration-secret-0001", // gitleaks:allow (test placeholder)
    BETTER_AUTH_URL: "http://localhost:3999",
    NEXT_PUBLIC_APP_URL: "http://localhost:3999",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    CRON_SECRET: "integration-cron-secret-integration-cron-01",
    AUDIT_IP_SALT: "integration-audit-salt-integration-salt-01",
    OIDC_ISSUER: "http://localhost:3998",
    OIDC_CLIENT_ID: "devops-manager",
    OIDC_CLIENT_SECRET: "integration-client-secret",
    ADMIN_EMAILS: "admin@example.com",
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "example-devops-manager",
    GITHUB_APP_PRIVATE_KEY: "unused-in-this-test",
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ALLOWED_ACCOUNTS: "example-user,example-org",
    BACKFILL_DAYS: "7",
    LAZY_RECONCILE_MINUTES: "15",
    ...extra,
  });
  delete process.env.SKIP_ENV_VALIDATION;
}

type Db = typeof DbModule.db;

export async function resetTables(db: Db) {
  await db.$executeRawUnsafe(`
    TRUNCATE "WorkflowJob", "WorkflowRun", "RollupDirty", "DailyWorkflowStat",
      "DailyJobStat", "DailyRunnerStat", "RunnerSample", "Runner",
      "BillingUsageItem", "GitHubCredential", "SyncState", "WebhookDelivery",
      "InstallationRateLimit", "AppState", "AuditLog", "Repository",
      "Installation" CASCADE`);
}

export const A = 1001n; // example-user (personal account)
export const B = 2002n; // example-org (organisation)

export async function seedInstallations(
  db: Db,
  opts: {
    rawRetentionDays?: number;
    lastReconciledAt?: Date | null;
    /** Extra granted permissions (both installations). */
    permissions?: Record<string, string>;
  } = {},
) {
  const perms = {
    metadata: "read",
    actions: "read",
    ...(opts.permissions ?? {}),
  };
  await db.installation.createMany({
    data: [
      {
        id: A,
        accountId: 1n,
        accountLogin: "example-user",
        accountType: "USER",
        repositorySelection: "ALL",
        permissions: perms,
        events: ["workflow_run", "workflow_job"],
        rawRetentionDays: opts.rawRetentionDays ?? 90,
        lastReconciledAt: opts.lastReconciledAt ?? null,
      },
      {
        id: B,
        accountId: 2n,
        accountLogin: "example-org",
        accountType: "ORGANIZATION",
        repositorySelection: "ALL",
        permissions: perms,
        events: ["workflow_run", "workflow_job"],
        rawRetentionDays: opts.rawRetentionDays ?? 90,
        lastReconciledAt: opts.lastReconciledAt ?? null,
      },
    ],
  });
  await db.repository.createMany({
    data: [
      {
        id: 11n,
        installationId: A,
        ownerLogin: "example-user",
        name: "repo-a",
        fullName: "example-user/repo-a",
        private: true,
      },
      {
        id: 22n,
        installationId: B,
        ownerLogin: "example-org",
        name: "repo-b",
        fullName: "example-org/repo-b",
        private: true,
      },
    ],
  });
}

export const REPOS = {
  [String(A)]: { id: 11, owner: "example-user", name: "repo-a" },
  [String(B)]: { id: 22, owner: "example-org", name: "repo-b" },
} as const;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

let nextId = 100_000;
export const freshId = () => nextId++;

export type RunSpec = {
  id?: number;
  createdAt: Date;
  durationS: number;
  queueS?: number;
  conclusion?: string;
  attempt?: number;
  workflowId?: number;
  workflowName?: string;
  branch?: string;
  labels?: string[];
  runnerName?: string;
  jobName?: string;
  /** Conclusion of attempt 1's job when attempt > 1. */
  firstConclusion?: string;
};

/** A completed run with one job per attempt, as GitHub's REST API returns it. */
export function makeRun(repo: { owner: string; name: string }, spec: RunSpec) {
  const id = spec.id ?? freshId();
  const attempt = spec.attempt ?? 1;
  const queue = spec.queueS ?? 10;
  const start = new Date(spec.createdAt.getTime() + queue * 1000);
  const end = new Date(start.getTime() + spec.durationS * 1000);
  const run: GhWorkflowRun = {
    id,
    workflow_id: spec.workflowId ?? 301,
    name: spec.workflowName ?? "CI",
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: spec.branch ?? "main",
    head_sha: "a".repeat(40),
    actor: { login: "example-user" },
    run_number: id % 1000,
    run_attempt: attempt,
    status: "completed",
    conclusion: spec.conclusion ?? "success",
    created_at: iso(spec.createdAt),
    run_started_at: iso(spec.createdAt),
    updated_at: iso(end),
    html_url: `https://github.com/${repo.owner}/${repo.name}/actions/runs/${id}`,
  };
  const jobs: GhWorkflowJob[] = [];
  for (let a = 1; a <= attempt; a++) {
    const last = a === attempt;
    jobs.push({
      id: id * 10 + a,
      run_id: id,
      run_attempt: a,
      workflow_name: run.name,
      head_branch: run.head_branch,
      head_sha: run.head_sha,
      name: spec.jobName ?? "test (ubuntu-latest)",
      labels: spec.labels ?? ["ubuntu-latest"],
      status: "completed",
      conclusion: last
        ? (spec.conclusion ?? "success")
        : (spec.firstConclusion ?? "failure"),
      created_at: iso(spec.createdAt),
      started_at: iso(start),
      completed_at: iso(end),
      runner_id: 7,
      runner_name: spec.runnerName ?? "GitHub Actions 7",
      runner_group_id: 1,
      runner_group_name: spec.runnerName ? "repo-runners" : "GitHub Actions",
    });
  }
  const attempts = new Map<number, GhWorkflowRun>();
  if (attempt > 1)
    attempts.set(1, {
      ...run,
      run_attempt: 1,
      conclusion: spec.firstConclusion ?? "failure",
    });
  return { run, jobs, attempts };
}

export type FakeRunner = {
  id: number;
  name: string;
  os?: string;
  status: "online" | "offline";
  busy: boolean;
  labels: string[];
  ephemeral?: boolean;
};

type RepoData = {
  owner: string;
  name: string;
  runs: Map<number, ReturnType<typeof makeRun>>;
};

export type HookDelivery = {
  id: number;
  guid: string;
  delivered_at: string;
  status_code: number;
  event: string;
  installation_id: number | null;
  repository_id: number | null;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly response?: { headers: Record<string, string> },
  ) {
    super(`HTTP ${status}`);
  }
}

/**
 * In-memory GitHub. Each installation token sees only its own repositories;
 * every request advances the fake clock by `msPerRequest`.
 */
export class FakeGitHub {
  readonly repos = new Map<string, Map<string, RepoData>>();
  readonly tokens: Array<{ installationId: bigint; purpose: string }> = [];
  readonly requests: Array<{
    installationId: bigint | null;
    route: string;
    params: Record<string, unknown>;
  }> = [];
  readonly redelivered: number[] = [];
  hookDeliveries: HookDelivery[] = [];
  failInstallations = new Set<bigint>();
  /** Runner lists: "repo:<owner>/<name>" or "org:<login>". */
  runners = new Map<string, FakeRunner[]>();
  /** Billing usage items per account login (dates are moved into the requested month). */
  billing = new Map<string, Array<Record<string, unknown>>>();
  /** Valid user tokens (PAT or user-to-server) and the login they belong to. */
  userTokens = new Map<string, string>();
  /** Status the billing endpoints answer with instead of data. */
  billingStatus: number | null = null;
  /** Runs GitHub no longer has (log retention): their job lists answer 404. */
  expiredRuns = new Set<number>();
  now = Date.now();
  msPerRequest = 0;
  remaining = 5000;

  clock = () => this.now;

  addRun(installationId: bigint, spec: RunSpec) {
    const repo = REPOS[String(installationId)]!;
    const byName =
      this.repos.get(String(installationId)) ?? new Map<string, RepoData>();
    this.repos.set(String(installationId), byName);
    const data = byName.get(repo.name) ?? {
      owner: repo.owner,
      name: repo.name,
      runs: new Map(),
    };
    byName.set(repo.name, data);
    const made = makeRun(repo, spec);
    data.runs.set(made.run.id, made);
    return made;
  }

  clients(): GitHubClients {
    return {
      app: () => this.api(null),
      installation: async (installationId, purpose, granted) => {
        // Like the token broker: a purpose without its permission fails.
        const { permissionsFor } = await import("@/server/github/purposes");
        permissionsFor(purpose, granted);
        this.tokens.push({ installationId, purpose });
        return this.api(installationId);
      },
      user: (token) => this.userApi(token),
    };
  }

  /** A client authenticated with a user token (personal billing only). */
  userApi(token: string): GitHubApi {
    return {
      request: async <T>(
        route: string,
        params: Record<string, unknown> = {},
      ) => {
        this.requests.push({
          installationId: null,
          route,
          params: { ...params, userToken: true },
        });
        const login = this.userTokens.get(token);
        if (!login) throw new HttpError(401);
        if (route !== "GET /users/{username}/settings/billing/usage")
          throw new HttpError(404);
        if (String(params.username) !== login) throw new HttpError(403);
        return {
          status: 200,
          headers: this.headers(),
          data: this.billingReport(login, params),
        } as GhResponse<T>;
      },
    };
  }

  private billingReport(login: string, params: Record<string, unknown>) {
    if (this.billingStatus) throw new HttpError(this.billingStatus);
    const ym = `${params.year}-${String(params.month).padStart(2, "0")}`;
    return {
      usageItems: (this.billing.get(login) ?? []).map((i) => ({
        ...i,
        date: String(i.date).replace(/^d{4}-d{2}/, ym),
      })),
    };
  }

  private headers(): Record<string, string> {
    this.remaining = Math.max(0, this.remaining - 1);
    return {
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": String(this.remaining),
      "x-ratelimit-reset": String(Math.floor(this.now / 1000) + 3600),
      "x-ratelimit-resource": "core",
    };
  }

  api(installationId: bigint | null): GitHubApi {
    return {
      request: async <T>(
        route: string,
        params: Record<string, unknown> = {},
      ) => {
        this.now += this.msPerRequest;
        this.requests.push({ installationId, route, params });
        if (
          installationId !== null &&
          this.failInstallations.has(installationId)
        )
          throw new HttpError(500);
        const res = this.route(installationId, route, params);
        return {
          status: 200,
          headers: this.headers(),
          data: res,
        } as GhResponse<T>;
      },
    };
  }

  private repo(installationId: bigint | null, params: Record<string, unknown>) {
    if (installationId === null) throw new HttpError(401);
    const data = this.repos
      .get(String(installationId))
      ?.get(String(params.repo));
    const expected = REPOS[String(installationId)];
    // A token of one installation cannot read another installation's repos.
    if (
      !expected ||
      params.owner !== expected.owner ||
      params.repo !== expected.name
    )
      throw new HttpError(404);
    return (
      data ?? { owner: expected.owner, name: expected.name, runs: new Map() }
    );
  }

  private route(
    installationId: bigint | null,
    route: string,
    params: Record<string, unknown>,
  ): unknown {
    switch (route) {
      case "GET /repos/{owner}/{repo}/actions/runs": {
        const data = this.repo(installationId, params);
        const created = String(params.created ?? "");
        const runs = [...data.runs.values()]
          .map((r) => r.run)
          .filter((r) => matchesCreated(Date.parse(r.created_at), created))
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        const perPage = Number(params.per_page ?? 30);
        const page = Number(params.page ?? 1);
        // GitHub never returns more than 1,000 results for one search.
        const capped = runs.slice(0, 1000);
        return {
          total_count: runs.length,
          workflow_runs: capped.slice((page - 1) * perPage, page * perPage),
        };
      }
      case "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs": {
        const data = this.repo(installationId, params);
        const run = data.runs.get(Number(params.run_id));
        if (!run) throw new HttpError(404);
        return { total_count: run.jobs.length, jobs: run.jobs };
      }
      case "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs": {
        const data = this.repo(installationId, params);
        const run = data.runs.get(Number(params.run_id));
        if (!run || this.expiredRuns.has(run.run.id)) throw new HttpError(404);
        const jobs = run.jobs
          .filter(
            (j: GhWorkflowJob) =>
              j.run_attempt === Number(params.attempt_number),
          )
          .map((j: GhWorkflowJob) => ({
            ...j,
            steps: [
              {
                number: 2,
                name: "Run tests",
                status: "completed",
                conclusion: j.conclusion,
                started_at: j.started_at,
                completed_at: j.completed_at,
              },
              {
                number: 1,
                name: "Set up job",
                status: "completed",
                conclusion: "success",
                started_at: j.started_at,
                completed_at: j.started_at,
              },
            ],
          }));
        return { total_count: jobs.length, jobs };
      }
      case "GET /repos/{owner}/{repo}/actions/runs/{run_id}": {
        const run = this.repo(installationId, params).runs.get(
          Number(params.run_id),
        );
        if (!run) throw new HttpError(404);
        return run.run;
      }
      case "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}": {
        const run = this.repo(installationId, params).runs.get(
          Number(params.run_id),
        );
        const attempt = run?.attempts.get(Number(params.attempt_number));
        if (!attempt) throw new HttpError(404);
        return attempt;
      }
      case "GET /repos/{owner}/{repo}/actions/jobs/{job_id}": {
        const data = this.repo(installationId, params);
        for (const r of data.runs.values())
          for (const j of r.jobs) if (j.id === Number(params.job_id)) return j;
        throw new HttpError(404);
      }
      case "GET /repos/{owner}/{repo}/actions/runners": {
        const data = this.repo(installationId, params);
        const list = this.runners.get(`repo:${data.owner}/${data.name}`) ?? [];
        return { total_count: list.length, runners: list.map(ghRunner) };
      }
      case "GET /orgs/{org}/actions/runners": {
        if (installationId === null) throw new HttpError(401);
        const expected = REPOS[String(installationId)];
        if (!expected || params.org !== expected.owner)
          throw new HttpError(404);
        const list = this.runners.get(`org:${expected.owner}`) ?? [];
        return { total_count: list.length, runners: list.map(ghRunner) };
      }
      case "GET /organizations/{org}/settings/billing/usage": {
        if (installationId === null) throw new HttpError(401);
        const expected = REPOS[String(installationId)];
        if (!expected || params.org !== expected.owner)
          throw new HttpError(404);
        return this.billingReport(expected.owner, params);
      }
      case "GET /app/hook/deliveries":
        if (installationId !== null) throw new HttpError(401);
        return [...this.hookDeliveries].sort((a, b) => b.id - a.id);
      case "POST /app/hook/deliveries/{delivery_id}/attempts":
        if (installationId !== null) throw new HttpError(401);
        this.redelivered.push(Number(params.delivery_id));
        return {};
      default:
        throw new HttpError(404);
    }
  }
}

function matchesCreated(t: number, created: string): boolean {
  if (!created) return true;
  if (created.startsWith(">=")) return t >= Date.parse(created.slice(2));
  const [a, b] = created.split("..");
  return t >= Date.parse(a!) && t <= Date.parse(b!) + 999;
}

function ghRunner(r: FakeRunner) {
  return {
    id: r.id,
    name: r.name,
    os: r.os ?? "Linux",
    status: r.status,
    busy: r.busy,
    ephemeral: r.ephemeral ?? false,
    labels: r.labels.map((name, i) => ({ id: i + 1, name, type: "read-only" })),
  };
}
