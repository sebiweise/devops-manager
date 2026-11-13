#!/usr/bin/env node
// Synthetic demo data for local screenshots and UI work (never production).
//
//   DATABASE_URL=postgresql://... node scripts/demo/seed.mjs [--app http://localhost:3000]
//
// Wipes the tenant tables of the target database and fills them with two
// installations (example-org, example-user), repo-a.. repositories (some
// forks, one archived, one ignored), 30 days of runs and jobs, queued jobs,
// self-hosted runners with samples, billing items, webhook deliveries and a
// Vercel team with projects, deployments (a failed production build and a
// rolled-back production), findings and hash-chained audit entries of the
// M6 actions (Vercel actions switched on, a rollback, a redeploy whose new
// deployment is linked to its entry), and an Azure DevOps organisation with
// pipelines (one on macOS), runs (a failed one, a retried one, one running,
// one queued), pools and hosted usage near the free tier (M7).
// Every name is a generic placeholder. With --app, it then calls the app's
// cron endpoint (CRON_SECRET from the environment) until the daily
// summaries are computed. Refuses to run when NODE_ENV=production or when
// the database URL does not point at localhost / 127.0.0.1.

import { createHash } from "node:crypto";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (process.env.NODE_ENV === "production") {
  console.error("refusing to seed demo data with NODE_ENV=production");
  process.exit(1);
}
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error("refusing to seed a non-local database");
  process.exit(1);
}
const appIdx = process.argv.indexOf("--app");
const appUrl = appIdx > 0 ? process.argv[appIdx + 1] : null;

// Deterministic pseudo-random numbers, so every seed looks the same.
let state = 42;
const rand = () => {
  state = (state * 1664525 + 1013904223) % 4294967296;
  return state / 4294967296;
};
/** @template T @param {T[]} arr @returns {T} */
const pick = (arr) => /** @type {T} */ (arr[Math.floor(rand() * arr.length)]);
/** @param {number} lo @param {number} hi */
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const ORG = 2002n;
const USER = 1001n;
const NOW = Date.now();
const MIN = 60_000;
const DAY = 86_400_000;

/** @type {Array<[number, bigint, string, string, boolean, boolean, boolean, boolean, number, boolean]>} */
const repos = [
  // [id, installation, owner, name, private, fork, archived, ignored, runsPerDay, selfHosted]
  [201, ORG, "example-org", "repo-a", true, false, false, false, 14, true],
  [202, ORG, "example-org", "repo-b", true, false, false, false, 9, false],
  [203, ORG, "example-org", "repo-c", true, false, false, false, 6, true],
  [204, ORG, "example-org", "repo-d", false, false, false, false, 4, false],
  [205, ORG, "example-org", "repo-e", true, false, false, false, 3, false],
  [206, ORG, "example-org", "repo-f", true, false, false, false, 2, true],
  [207, ORG, "example-org", "repo-g", false, false, false, false, 1, false],
  [208, ORG, "example-org", "repo-h", true, false, true, false, 0, false],
  [209, ORG, "example-org", "repo-i", false, true, false, false, 2, false],
  [210, ORG, "example-org", "repo-j", false, true, false, false, 1, false],
  [211, ORG, "example-org", "repo-k", false, true, false, false, 0, false],
  [212, ORG, "example-org", "repo-l", false, true, false, true, 0, false],
  [101, USER, "example-user", "repo-x", true, false, false, false, 5, false],
  [102, USER, "example-user", "repo-y", false, true, false, false, 1, false],
];

/** @type {[{ suffix: number; name: string; jobs: string[] }, { suffix: number; name: string; jobs: string[] }, { suffix: number; name: string; jobs: string[] }]} */
const WORKFLOWS = [
  { suffix: 1, name: "CI", jobs: ["build", "test (ubuntu-latest)", "lint"] },
  { suffix: 2, name: "Release", jobs: ["package", "publish"] },
  { suffix: 3, name: "Nightly", jobs: ["integration"] },
];

const client = new pg.Client({ connectionString: url });
await client.connect();

/** @param {string} table @param {Array<Record<string, any>>} rows */
async function insert(table, rows) {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0] ?? {});
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    /** @type {unknown[]} */
    const values = [];
    const tuples = chunk.map((row) => {
      const ph = cols.map((c) => {
        values.push(row[c]);
        return `$${values.length}`;
      });
      return `(${ph.join(",")})`;
    });
    await client.query(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES ${tuples.join(",")}`,
      values,
    );
  }
}

/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();

await client.query(`
  TRUNCATE "WorkflowJob", "WorkflowRun", "RollupDirty", "DailyWorkflowStat",
    "DailyJobStat", "DailyRunnerStat", "RunnerSample", "Runner",
    "BillingUsageItem", "GitHubCredential", "SyncState", "WebhookDelivery",
    "InstallationRateLimit", "AuditLog", "AuditChainHead", "VercelDeployment",
    "VercelProject", "VercelConnection", "DailyDeploymentStat", "Finding",
    "FeatureAvailability", "AzureBuildJob", "AzureBuild", "AzurePipelineDefinition",
    "AzureDevOpsProject", "AzureAgent", "AzurePoolSample", "AzurePool",
    "AzureJobRequest", "DailyAzureUsage", "AzureUsageSnapshot",
    "AzureHookSubscription", "PipelineRollupDirty", "DailyPipelineStat",
    "AzureDevOpsConnection", "Repository", "Installation" CASCADE`);

const permissions = JSON.stringify({
  metadata: "read",
  actions: "write",
  administration: "read",
  organization_self_hosted_runners: "read",
  organization_administration: "read",
  pull_requests: "write",
  contents: "write",
  checks: "read",
  vulnerability_alerts: "read",
  actions_variables: "write",
  organization_actions_variables: "write",
});
/** @param {number} minutes */
const recent = (minutes) => iso(NOW - minutes * MIN);
await insert("Installation", [
  {
    id: ORG,
    accountId: 2n,
    accountLogin: "example-org",
    accountType: "ORGANIZATION",
    repositorySelection: "ALL",
    permissions,
    events:
      "{workflow_run,workflow_job,deployment_status,check_run,check_suite}",
    permissionsCheckedAt: recent(1),
    managementEnabled: true,
    includedMinutes: 3000,
    planName: "team",
    lastWebhookAt: recent(3),
    lastReconciledAt: recent(12),
    lastReconcileStatus: "ok",
    runnersSampledAt: recent(2),
    runnersDiscoveredAt: recent(60),
    billingSyncedAt: recent(120),
    billingStatus: "ok",
    lastPrunedAt: recent(300),
    updatedAt: recent(1),
  },
  {
    id: USER,
    accountId: 1n,
    accountLogin: "example-user",
    accountType: "USER",
    repositorySelection: "SELECTED",
    permissions,
    events: "{workflow_run,workflow_job}",
    permissionsCheckedAt: recent(1),
    managementEnabled: false,
    includedMinutes: 2000,
    planName: "pro",
    lastWebhookAt: recent(45),
    lastReconciledAt: recent(30),
    lastReconcileStatus: "ok",
    lastPrunedAt: recent(300),
    updatedAt: recent(1),
  },
]);

const alertsOf = new Map(repos.map((r) => [r[0], between(0, 4)]));
await insert(
  "Repository",
  repos.map(([id, inst, owner, name, priv, fork, archived, ignored]) => ({
    id: BigInt(id),
    installationId: inst,
    ownerLogin: owner,
    name,
    fullName: `${owner}/${name}`,
    private: priv,
    fork,
    archived,
    ignoredAt: ignored ? iso(NOW - 3 * DAY) : null,
    ignorePurgedAt: ignored ? iso(NOW - 3 * DAY + 10 * MIN) : null,
    openPrCount: ignored ? null : between(0, 6),
    openAlertCount: ignored ? null : (alertsOf.get(id) ?? 0),
    openAlertHighCount: ignored
      ? null
      : Math.min(alertsOf.get(id) ?? 0, between(0, 1)),
    countsRefreshedAt: ignored ? null : recent(20),
    hasSelfHosted: repos.find((r) => r[0] === id)?.[9] ?? false,
    updatedAt: recent(5),
  })),
);
await insert(
  "SyncState",
  repos
    .filter((r) => !r[7])
    .map(([id, inst]) => ({
      repositoryId: BigInt(id),
      installationId: inst,
      runsCursor: recent(3),
      backfillUntil: iso(NOW - 30 * DAY),
      backfillDone: true,
      updatedAt: recent(3),
    })),
);

// ---------- runs and jobs ----------
const runs = [];
const jobs = [];
const dirty = new Set();
let runId = 9_000_000;
let jobId = 90_000_000;
const runnerNames = ["runner-1", "runner-2", "runner-3"];
for (const [
  id,
  inst,
  owner,
  name,
  priv,
  ,
  ,
  ignored,
  perDay,
  selfHosted,
] of repos) {
  if (ignored || perDay === 0) continue;
  const repoId = BigInt(id);
  for (let d = 29; d >= 0; d--) {
    const weekday = new Date(NOW - d * DAY).getUTCDay();
    const n = Math.max(
      0,
      Math.round(
        perDay *
          (weekday === 0 || weekday === 6 ? 0.3 : 1) *
          (0.6 + rand() * 0.8),
      ),
    );
    for (let i = 0; i < n; i++) {
      const wf =
        rand() < 0.75
          ? WORKFLOWS[0]
          : rand() < 0.6
            ? WORKFLOWS[2]
            : WORKFLOWS[1];
      const created = NOW - d * DAY - between(10, 23 * 60) * MIN;
      if (created > NOW - 5 * MIN) continue;
      const fails = rand() < (name === "repo-c" ? 0.3 : 0.08);
      const flaky = !fails && rand() < 0.05;
      const attempt = flaky ? 2 : 1;
      const conclusion = fails
        ? rand() < 0.8
          ? "FAILURE"
          : "CANCELLED"
        : "SUCCESS";
      const id_ = runId++;
      const workflowId = BigInt(id * 10 + wf.suffix);
      let end = created;
      const onSelf = selfHosted && wf.suffix !== 2 && rand() < 0.7;
      const windows = !onSelf && name === "repo-b" && rand() < 0.3;
      const labels = onSelf
        ? ["linux", "self-hosted", "x64"]
        : windows
          ? ["windows-latest"]
          : ["ubuntu-latest"];
      for (let a = 1; a <= attempt; a++) {
        for (const job of wf.jobs) {
          const queueS = onSelf
            ? between(5, d < 2 ? 900 : 240)
            : between(3, 40);
          const durationS = Math.round(
            (job === "integration" ? 900 : job.startsWith("test") ? 420 : 150) *
              (0.6 + rand() * 0.9) *
              (name === "repo-a" && d < 7 ? 1.4 : 1),
          );
          const start = created + (a - 1) * 20 * MIN + queueS * 1000;
          const stop = start + durationS * 1000;
          end = Math.max(end, stop);
          const jobConclusion =
            a < attempt
              ? "FAILURE"
              : job === wf.jobs[0]
                ? conclusion
                : conclusion === "SUCCESS"
                  ? "SUCCESS"
                  : "SKIPPED";
          const hostedMinutes = Math.ceil(durationS / 60) * (windows ? 2 : 1);
          jobs.push({
            id: BigInt(jobId++),
            runId: BigInt(id_),
            runAttempt: a,
            installationId: inst,
            repositoryId: repoId,
            workflowId,
            workflowName: wf.name,
            name: job,
            baseName: job.replace(/ \(.*\)$/, ""),
            labels: `{${labels.join(",")}}`,
            labelKey: labels.join(","),
            status: "COMPLETED",
            statusRank: 4,
            conclusion: jobConclusion,
            runnerName: onSelf
              ? pick(runnerNames)
              : `GitHub Actions ${between(1, 99)}`,
            runnerKind: onSelf ? "SELF_HOSTED" : "GITHUB_HOSTED",
            runnerOs: windows ? "WINDOWS" : "LINUX",
            sku: onSelf ? null : windows ? "windows" : "linux",
            createdAt: iso(created),
            startedAt: iso(start),
            completedAt: iso(stop),
            queueS,
            durationS,
            billableMinEst: onSelf || !priv ? 0 : hostedMinutes,
            source: "WEBHOOK",
            lastEventAt: iso(stop),
          });
        }
      }
      runs.push({
        id: BigInt(id_),
        installationId: inst,
        repositoryId: repoId,
        workflowId,
        workflowName: wf.name,
        workflowPath: `.github/workflows/${wf.name.toLowerCase()}.yml`,
        event:
          wf.suffix === 3 ? "schedule" : pick(["push", "push", "pull_request"]),
        headBranch: pick([
          "main",
          "main",
          "feature-x",
          "dependabot/npm/example",
        ]),
        // Fake 40-hex commit SHAs for demo data, not a security use.
        headSha: createHash("sha1").update(`run-${id_}`).digest("hex"), // NOSONAR(javascript:S4790)
        isDefaultBranch: true,
        actorLogin: "example-user",
        runNumber: id_ % 10_000,
        runAttempt: attempt,
        firstAttemptConclusion: attempt > 1 ? "FAILURE" : conclusion,
        status: "COMPLETED",
        statusRank: 4,
        conclusion,
        createdAt: iso(created),
        runStartedAt: iso(created),
        completedAt: iso(end),
        durationS: Math.round((end - created) / 1000),
        htmlUrl: `https://github.com/${owner}/${name}/actions/runs/${id_}`,
        githubUpdatedAt: iso(end),
        jobsSyncedAt: iso(end),
        source: "WEBHOOK",
        lastEventAt: iso(end),
      });
      dirty.add(
        `${inst}|${id}|${new Date(created).toISOString().slice(0, 10)}`,
      );
    }
  }
}

// Live queue: a few queued jobs, one stuck on self-hosted, one without a runner.
/** @type {Array<[number, string, number, string, string]>} */
const queued = [
  [201, "linux,self-hosted,x64", 22, "test (ubuntu-latest)", "CI"],
  [201, "linux,self-hosted,x64", 3, "build", "CI"],
  [203, "gpu,self-hosted", 40, "train", "Nightly"],
  [202, "ubuntu-latest", 1, "lint", "CI"],
  [202, "ubuntu-latest", 2, "build", "CI"],
];
for (const [repo, labelKey, ageMin, job, wfName] of queued) {
  const r = repos.find((x) => x[0] === repo);
  if (!r) continue;
  const id_ = runId++;
  const created = NOW - ageMin * MIN;
  runs.push({
    id: BigInt(id_),
    installationId: r[1],
    repositoryId: BigInt(repo),
    workflowId: BigInt(repo * 10 + 1),
    workflowName: wfName,
    headSha: "f".repeat(40),
    headBranch: "main",
    isDefaultBranch: true,
    runAttempt: 1,
    status: "QUEUED",
    statusRank: 1,
    createdAt: iso(created),
    source: "WEBHOOK",
    lastEventAt: iso(created),
  });
  jobs.push({
    id: BigInt(jobId++),
    runId: BigInt(id_),
    runAttempt: 1,
    installationId: r[1],
    repositoryId: BigInt(repo),
    workflowId: BigInt(repo * 10 + 1),
    workflowName: wfName,
    name: job,
    baseName: job.replace(/ \(.*\)$/, ""),
    labels: `{${labelKey}}`,
    labelKey,
    status: "QUEUED",
    statusRank: 1,
    runnerKind: labelKey.includes("self-hosted")
      ? "SELF_HOSTED"
      : "GITHUB_HOSTED",
    createdAt: iso(created),
    lastQueuedAt: iso(created),
    source: "WEBHOOK",
    lastEventAt: iso(created),
  });
}
// An environment approval.
{
  const id_ = runId++;
  const created = NOW - 35 * MIN;
  runs.push({
    id: BigInt(id_),
    installationId: ORG,
    repositoryId: 205n,
    workflowId: 2052n,
    workflowName: "Release",
    headSha: "e".repeat(40),
    headBranch: "main",
    isDefaultBranch: true,
    runAttempt: 1,
    status: "WAITING",
    statusRank: 2,
    createdAt: iso(created),
    source: "WEBHOOK",
    lastEventAt: iso(created),
  });
  jobs.push({
    id: BigInt(jobId++),
    runId: BigInt(id_),
    runAttempt: 1,
    installationId: ORG,
    repositoryId: 205n,
    workflowId: 2052n,
    workflowName: "Release",
    name: "deploy",
    baseName: "deploy",
    labels: "{ubuntu-latest}",
    labelKey: "ubuntu-latest",
    status: "WAITING",
    statusRank: 2,
    runnerKind: "GITHUB_HOSTED",
    createdAt: iso(created),
    waitingStartedAt: iso(created),
    source: "WEBHOOK",
    lastEventAt: iso(created),
  });
}

// Run rows need every column the INSERT names; fill the missing ones.
const runCols = [...new Set(runs.flatMap((r) => Object.keys(r)))];
const jobCols = [...new Set(jobs.flatMap((r) => Object.keys(r)))];
/** @param {Array<Record<string, unknown>>} rows @param {string[]} cols */
const fill = (rows, cols) =>
  rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
await insert("WorkflowRun", fill(runs, runCols));
await insert(
  "WorkflowJob",
  fill(jobs, jobCols).map((j) => ({
    ...j,
    waitingS: j.waitingS ?? 0,
    runnerOs: j.runnerOs ?? "UNKNOWN",
  })),
);
await insert(
  "RollupDirty",
  [...dirty].map((k) => {
    const [inst, repo, day] = k.split("|");
    return {
      installationId: BigInt(inst),
      repositoryId: BigInt(repo),
      day,
      markedAt: iso(NOW),
    };
  }),
);

// ---------- runners and samples ----------
/** @type {Array<[string, string, bigint | null, number, string, boolean, boolean]>} */
const runners = [
  ["2002:ORG:501", "ORG", null, 501, "runner-1", true, false],
  ["2002:ORG:502", "ORG", null, 502, "runner-2", true, true],
  ["2002:ORG:503", "ORG", null, 503, "runner-3", false, false],
  ["2002:REPO:601", "REPO", 203n, 601, "repo-c-runner", true, false],
];
await insert(
  "Runner",
  runners.map(([key, scope, repositoryId, gid, name, online, busy]) => ({
    key,
    installationId: ORG,
    scope,
    repositoryId,
    githubRunnerId: BigInt(gid),
    name,
    os: "Linux",
    labels:
      name === "repo-c-runner"
        ? "{gpu,self-hosted}"
        : "{linux,self-hosted,x64}",
    groupName: scope === "ORG" ? "Default" : null,
    online,
    busy,
    firstSeenAt: iso(NOW - 40 * DAY),
    lastSeenAt: recent(2),
    lastOnlineAt: online ? recent(2) : iso(NOW - 2 * DAY),
  })),
);
const samples = [];
for (const [key, , , , , online] of runners)
  for (let t = NOW - 7 * DAY; t <= NOW; t += 10 * MIN)
    samples.push({
      installationId: ORG,
      runnerKey: key,
      sampledAt: iso(t),
      online: online || t < NOW - 2 * DAY,
      busy: rand() < 0.35,
      intervalS: 600,
    });
await insert("RunnerSample", samples);

// ---------- billing (this month, per repo, including the ignored one) ----------
const month = new Date(NOW);
const billing = [];
for (let d = 1; d <= month.getUTCDate(); d++) {
  const date = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  /** @type {Array<[string, string, number, number]>} */
  const items = [
    ["example-org/repo-a", "Actions Linux", 0.006, 120],
    ["example-org/repo-b", "Actions Linux", 0.006, 80],
    ["example-org/repo-b", "Actions Windows", 0.01, 25],
    ["example-org/repo-e", "Actions Linux", 0.006, 30],
    ["example-org/repo-l", "Actions Linux", 0.006, 40],
    ["", "Actions storage", 0.0008, 50],
  ];
  for (const [repo, sku, perMin, qty] of items) {
    const quantity = Math.round(qty * (0.5 + rand()));
    const gross = quantity * perMin;
    const discount = d < 12 ? gross : gross * 0.2;
    billing.push({
      installationId: ORG,
      date,
      product: "Actions",
      sku,
      repositoryFullName: repo,
      unitType: sku === "Actions storage" ? "GigabyteHours" : "Minutes",
      quantity,
      pricePerUnit: perMin,
      grossAmount: gross.toFixed(6),
      discountAmount: discount.toFixed(6),
      netAmount: (gross - discount).toFixed(6),
      fetchedAt: recent(120),
    });
  }
}
await insert("BillingUsageItem", billing);

// ---------- webhook deliveries ----------
await insert(
  "WebhookDelivery",
  Array.from({ length: 40 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    event: i % 2 ? "workflow_job" : "workflow_run",
    action: "completed",
    installationId: ORG,
    repositoryId: 201n,
    payloadBytes: 4000,
    status: i === 7 ? "SKIPPED" : "PROCESSED",
    error: i === 7 ? "repo_ignored" : null,
    receivedAt: iso(NOW - i * 7 * MIN),
    processedAt: iso(NOW - i * 7 * MIN + 400),
  })),
);

// ---------- hosting: a Vercel team for example-org (synthetic) ----------
// The org's connection holds no token (accessToken null), so the app makes
// no Vercel call in the demo; example-user's connection is "revoked" to show
// the reconnect banner. Deployments follow the seeded push runs of repo-a..d
// (same commit SHAs), so the run and pull request pages show "Deployed as".
await insert("VercelConnection", [
  {
    installationId: ORG,
    teamId: "team_exampleteam0000000001",
    teamSlug: "example-team",
    teamName: "Example Team",
    plan: "hobby",
    tokenSource: "DB",
    accessToken: null,
    tokenHint: "a1b2",
    tokenScope: "team",
    tokenExpiresAt: iso(NOW + 9 * DAY),
    managementEnabled: true,
    createdByUserId: "demo",
    revokedAt: null,
    lastError: null,
    lastUsedAt: recent(4),
    lastSyncStatus: "ok",
    lastSyncedAt: recent(2),
    projectsSyncedAt: recent(90),
    deploymentsCursor: BigInt(NOW - 30 * MIN),
    updatedAt: recent(2),
  },
  {
    installationId: USER,
    teamId: "team_exampleteam0000000002",
    teamSlug: "example-user-team",
    teamName: "Example User",
    plan: "hobby",
    tokenSource: "DB",
    accessToken: null,
    tokenHint: "c3d4",
    tokenScope: "team",
    tokenExpiresAt: null,
    managementEnabled: false,
    createdByUserId: "demo",
    lastUsedAt: null,
    deploymentsCursor: null,
    revokedAt: iso(NOW - 2 * DAY),
    lastSyncStatus: "credential_error",
    lastSyncedAt: iso(NOW - 2 * DAY),
    lastError: "401 Not authorized",
    projectsSyncedAt: iso(NOW - 2 * DAY),
    updatedAt: iso(NOW - 2 * DAY),
  },
]);
/** @type {Array<[string, bigint, string, string, bigint | null, string | null, bigint | null]>} */
const projects = [
  // [id, installation, name, framework, repoId, linkRepo, manualRepoId]
  [
    "prj_demo00000000000000001",
    ORG,
    "project-a",
    "nextjs",
    201n,
    "example-org/repo-a",
    null,
  ],
  [
    "prj_demo00000000000000002",
    ORG,
    "project-b",
    "vite",
    202n,
    "example-org/repo-b",
    null,
  ],
  ["prj_demo00000000000000003", ORG, "project-c", "nextjs", null, null, 203n],
  [
    "prj_demo00000000000000004",
    ORG,
    "docs",
    "astro",
    204n,
    "example-org/repo-d",
    null,
  ],
  [
    "prj_demo00000000000000005",
    USER,
    "project-x",
    "nextjs",
    101n,
    "example-user/repo-x",
    null,
  ],
];
const projectOfRepo = new Map(projects.map((p) => [p[4] ?? p[6], p]));
/** @type {Array<Record<string, any>>} */
const deployments = [];
let dplSeq = 0;
for (const r of runs) {
  const p = projectOfRepo.get(r.repositoryId);
  if (!p || r.workflowName !== "CI" || r.event === "schedule") continue;
  const created = Date.parse(r.createdAt) + 2 * MIN;
  if (created > NOW - 3 * MIN) continue;
  const production = r.headBranch === "main" && rand() < 0.5;
  const failed = rand() < (p[2] === "project-c" ? 0.15 : 0.05);
  const canceled = !failed && rand() < 0.03;
  const buildS = between(35, p[3] === "astro" ? 70 : 160);
  deployments.push({
    id: `dpl_demo${String(dplSeq++).padStart(17, "0")}`,
    installationId: p[1],
    projectId: p[0],
    target: production ? "production" : "preview",
    state: failed ? "ERROR" : canceled ? "CANCELED" : "READY",
    readySubstate:
      failed || canceled ? null : production ? "PROMOTED" : "STAGED",
    url: `${p[2]}-${(dplSeq * 7919).toString(36)}-example-team.vercel.app`,
    branch: r.headBranch,
    commitSha: r.headSha,
    commitMessage: pick([
      "feat: add search to the list view",
      "fix: handle empty responses",
      "chore(deps): update dependencies",
      "docs: explain the setup",
      "refactor: split the settings form",
    ]),
    creatorKind: p[6] ? "cli" : "git",
    errorCode: failed ? "BUILD_FAILED" : null,
    isRollbackCandidate: production && !failed && !canceled,
    createdAt: iso(created),
    buildingAt: iso(created + 8_000),
    readyAt: failed || canceled ? null : iso(created + 8_000 + buildS * 1000),
    buildMs: failed || canceled ? null : buildS * 1000,
    syncedAt: recent(2),
  });
}
// A failed production build of project-a (newest) and a rolled-back
// production of project-b (served from an older deployment).
/** @param {bigint} repoId */
const lastSha = (repoId) =>
  // Fake 40-hex commit SHA for demo data, not a security use.
  createHash("sha1").update(`synthetic-${repoId}`).digest("hex"); // NOSONAR(javascript:S4790)
deployments.push({
  id: "dpl_demo_failed_production",
  installationId: ORG,
  projectId: "prj_demo00000000000000001",
  target: "production",
  state: "ERROR",
  readySubstate: null,
  url: null,
  branch: "main",
  commitSha: lastSha(201n),
  commitMessage: "feat: move the build to the new bundler",
  creatorKind: "git",
  errorCode: "BUILD_FAILED",
  isRollbackCandidate: false,
  createdAt: iso(NOW - 40 * MIN),
  buildingAt: iso(NOW - 40 * MIN + 8_000),
  readyAt: null,
  buildMs: null,
  syncedAt: recent(2),
});
deployments.push({
  id: "dpl_demo_building_preview",
  installationId: ORG,
  projectId: "prj_demo00000000000000002",
  target: "preview",
  state: "BUILDING",
  readySubstate: null,
  url: null,
  branch: "feature-x",
  commitSha: lastSha(202n),
  commitMessage: "feat: new onboarding steps",
  creatorKind: "git",
  errorCode: null,
  isRollbackCandidate: false,
  createdAt: iso(NOW - 4 * MIN),
  buildingAt: iso(NOW - 3 * MIN),
  readyAt: null,
  buildMs: null,
  syncedAt: recent(2),
});
// A preview of project-c redeployed from this app (M6): linked to its audit
// entry through meta.devopsManagerAudit.
const AUDIT_TOGGLE = "5c0c2d8e-1f4a-4b6c-9d2e-3a4b5c6d7e01";
const AUDIT_ROLLBACK = "5c0c2d8e-1f4a-4b6c-9d2e-3a4b5c6d7e02";
const AUDIT_REDEPLOY = "5c0c2d8e-1f4a-4b6c-9d2e-3a4b5c6d7e03";
deployments.push({
  id: "dpl_demo_redeployed_preview",
  installationId: ORG,
  projectId: "prj_demo00000000000000003",
  target: "preview",
  state: "READY",
  readySubstate: "STAGED",
  url: "project-c-redeploy-example-team.vercel.app",
  branch: "feature-y",
  commitSha: lastSha(203n),
  commitMessage: "fix: retry the flaky image step",
  creatorKind: "redeploy",
  errorCode: null,
  isRollbackCandidate: false,
  auditLogId: AUDIT_REDEPLOY,
  auditLinkKind: "exact",
  createdAt: iso(NOW - 25 * MIN),
  buildingAt: iso(NOW - 25 * MIN + 8_000),
  readyAt: iso(NOW - 25 * MIN + 98_000),
  buildMs: 90_000,
  syncedAt: recent(2),
});
for (const d of deployments) {
  d.auditLogId ??= null;
  d.auditLinkKind ??= null;
}
/** @param {string} projectId */
const prodOf = (projectId) =>
  deployments
    .filter(
      (d) =>
        d.projectId === projectId &&
        d.target === "production" &&
        d.state === "READY",
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
const liveOf = new Map(
  projects.map((p) => {
    const prods = prodOf(p[0]);
    // project-b: production was rolled back to the second-newest deployment.
    return [p[0], (p[2] === "project-b" ? prods[1] : prods[0])?.id ?? null];
  }),
);
await insert(
  "VercelProject",
  projects.map(([id, inst, name, framework, repoId, linkRepo, manual]) => {
    const latest = deployments
      .filter((d) => d.projectId === id && d.target === "production")
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return {
      id,
      installationId: inst,
      name,
      framework,
      linkType: repoId ? "github" : null,
      linkRepoId: repoId,
      linkRepo,
      productionBranch: "main",
      repositoryId: repoId,
      manualRepositoryId: manual,
      latestProdDeploymentId: latest?.id ?? null,
      latestProdState: latest?.state ?? null,
      latestProdReadyAt: latest?.readyAt ?? null,
      liveProdDeploymentId: liveOf.get(id),
      autoAssignPausedAt:
        name === "project-b" ? iso(NOW - 5 * 3_600_000) : null,
      // project-b was rolled back from this app (see the audit entries).
      aliasRequestType: name === "project-b" ? "rollback" : null,
      aliasRequestStatus: name === "project-b" ? "succeeded" : null,
      aliasRequestAt: name === "project-b" ? iso(NOW - 5 * 3_600_000) : null,
      aliasToDeploymentId: name === "project-b" ? liveOf.get(id) : null,
      updatedAt: recent(2),
    };
  }),
);
await insert("VercelDeployment", deployments);
// Daily stats per project, UTC day and target.
/** @type {Map<string, Record<string, any>>} */
const stats = new Map();
for (const d of deployments) {
  const day = d.createdAt.slice(0, 10);
  const k = `${d.projectId}|${day}|${d.target}`;
  const s = stats.get(k) ?? {
    installationId: d.installationId,
    projectId: d.projectId,
    day,
    target: d.target,
    total: 0,
    ready: 0,
    error: 0,
    canceled: 0,
    builds: [],
  };
  s.total++;
  if (d.state === "READY") s.ready++;
  if (d.state === "ERROR") s.error++;
  if (d.state === "CANCELED") s.canceled++;
  if (d.buildMs) s.builds.push(d.buildMs);
  stats.set(k, s);
}
/** @param {number[]} xs @param {number} q */
const quantile = (xs, q) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
};
await insert(
  "DailyDeploymentStat",
  [...stats.values()].map(({ builds, ...s }) => ({
    ...s,
    buildMsP50: quantile(builds, 0.5),
    buildMsP90: quantile(builds, 0.9),
  })),
);
/**
 * @param {bigint} inst @param {string} ruleKey @param {string} source
 * @param {string} severity @param {string} title
 * @param {Record<string, string>} details
 */
const finding = (inst, ruleKey, source, severity, title, details) => ({
  id: `finding-${ruleKey.replace(/[^a-z0-9]/gi, "-")}`,
  installationId: inst,
  repositoryId: null,
  source,
  ruleKey,
  severity,
  status: "OPEN",
  title,
  externalUrl: details.projectName
    ? `https://vercel.com/example-team/${details.projectName}`
    : null,
  details: JSON.stringify(details),
  firstSeenAt: iso(NOW - 40 * MIN),
  lastSeenAt: recent(2),
});
await insert("Finding", [
  finding(
    ORG,
    "vercel:prod-failing:prj_demo00000000000000001",
    "VERCEL",
    "HIGH",
    "project-a: production deployment failed",
    {
      kind: "prod_failing",
      projectId: "prj_demo00000000000000001",
      projectName: "project-a",
      repositoryId: "201",
    },
  ),
  finding(
    ORG,
    "vercel:auto-assign-paused:prj_demo00000000000000002",
    "VERCEL",
    "MEDIUM",
    "project-b: production auto-assignment paused",
    {
      kind: "auto_assign_paused",
      projectId: "prj_demo00000000000000002",
      projectName: "project-b",
      since: iso(NOW - 5 * 3_600_000),
      promoteDeploymentId: prodOf("prj_demo00000000000000002")[0]?.id ?? "",
      repositoryId: "202",
    },
  ),
  finding(
    ORG,
    "vercel:token-expiring",
    "CREDENTIAL",
    "MEDIUM",
    "Vercel token expires soon",
    {
      kind: "token_expiring",
      expiresAt: iso(NOW + 9 * DAY),
    },
  ),
  finding(
    USER,
    "vercel:credential-revoked",
    "CREDENTIAL",
    "HIGH",
    "Vercel token rejected; reconnect required",
    {
      kind: "credential_revoked",
      since: iso(NOW - 2 * DAY),
    },
  ),
]);

// ---------- CI: a synthetic Azure DevOps organisation for example-org (M7) ----------
// The connection holds no secret (accessToken null), so the app makes no
// Azure DevOps call in the demo. Pipelines of project-a build repo-a..d (one
// on macOS, one near the 60-minute job limit), a fifth points at a
// repository outside this installation (unlinked). One failed default branch, one
// retried run (attempt 2, flaky-recovered), one running and one queued run.
// Job requests put the hosted minutes of this month near the free tier.
const AZ_ORG_ID = "00000000-0000-4000-8000-000000000001";
const AZ_P1 = "00000000-0000-4000-8000-000000000011";
const AZ_P2 = "00000000-0000-4000-8000-000000000012";
const AZ_HOSTED_POOL = 9;
const AZ_SELF_POOL = 12;
await insert("AzureDevOpsConnection", [
  {
    installationId: ORG,
    orgId: AZ_ORG_ID,
    orgName: "contoso-ci",
    authKind: "PAT",
    accessToken: null,
    tokenHint: "c0d3",
    tokenExpiresAt: iso(NOW + 60 * DAY),
    scopes: JSON.stringify({
      projects: "ok",
      pools: "ok",
      builds: "ok",
      execute: "ok",
      hooks: "unknown",
    }),
    managementEnabled: true,
    hostedParallelJobs: 1,
    includedMinutes: 1800,
    maxJobMinutes: 60,
    monthResetDay: 1,
    blockWhenQuotaExhausted: false,
    detectedLimits: JSON.stringify({
      totalMinutes: 1800,
      totalCount: 1,
      isPremium: false,
    }),
    createdByUserId: "demo-admin",
    lastSyncStatus: "ok",
    lastSyncedAt: recent(4),
    lastUsedAt: recent(4),
    definitionsSyncedAt: recent(90),
    poolsSampledAt: recent(4),
    usageSyncedAt: recent(30),
    jobRequestsAvailable: true,
    checkAppSlug: "azure-pipelines",
    updatedAt: recent(4),
  },
]);
await insert("AzureDevOpsProject", [
  {
    installationId: ORG,
    id: AZ_P1,
    name: "project-a",
    visibility: "private",
    selected: true,
    buildsCursor: recent(5),
    backfillDone: true,
    updatedAt: recent(5),
  },
  {
    installationId: ORG,
    id: AZ_P2,
    name: "project-b",
    visibility: "public",
    selected: false,
    backfillDone: false,
    updatedAt: recent(5),
  },
]);
/** @type {Array<{ id: number; name: string; repoId: number | null; linkRepo: string; os: "LINUX" | "WINDOWS" | "MACOS"; image: string; perDay: number; minS: number; maxS: number; jobs: string[]; fail: number }>} */
const azDefs = [
  {
    id: 11,
    name: "ci-linux",
    repoId: 201,
    linkRepo: "example-org/repo-a",
    os: "LINUX",
    image: "ubuntu-latest",
    perDay: 4,
    minS: 240,
    maxS: 540,
    jobs: ["build", "test"],
    fail: 0.08,
  },
  {
    id: 12,
    name: "ios-build",
    repoId: 202,
    linkRepo: "example-org/repo-b",
    os: "MACOS",
    image: "macOS-14",
    perDay: 2,
    minS: 900,
    maxS: 1500,
    jobs: ["build_ios"],
    fail: 0.15,
  },
  {
    id: 13,
    name: "windows-tests",
    repoId: 203,
    linkRepo: "example-org/repo-c",
    os: "WINDOWS",
    image: "windows-latest",
    perDay: 1,
    minS: 600,
    maxS: 1000,
    jobs: ["test_windows"],
    fail: 0.1,
  },
  {
    id: 14,
    name: "nightly-e2e",
    repoId: 201,
    linkRepo: "example-org/repo-a",
    os: "LINUX",
    image: "ubuntu-latest",
    perDay: 0.5,
    minS: 3000,
    maxS: 3560,
    jobs: ["e2e"],
    fail: 0.2,
  },
  {
    id: 15,
    name: "legacy-app",
    repoId: null,
    linkRepo: "example-other/legacy-app",
    os: "LINUX",
    image: "ubuntu-latest",
    perDay: 0.5,
    minS: 300,
    maxS: 600,
    jobs: ["build"],
    fail: 0.1,
  },
];
await insert(
  "AzurePipelineDefinition",
  azDefs.map((d) => ({
    installationId: ORG,
    projectId: AZ_P1,
    id: d.id,
    name: d.name,
    path: "\\",
    yamlPath: d.id === 14 ? "pipelines/nightly.yml" : "azure-pipelines.yml",
    repoType: "GitHub",
    linkRepoFullName: d.linkRepo,
    repositoryId: d.repoId,
    defaultBranch: "main",
    queueStatus: "enabled",
    updatedAt: recent(90),
  })),
);
const hex40 = () =>
  Array.from({ length: 40 }, () => "0123456789abcdef"[between(0, 15)]).join("");
/** @param {number} n */
const recId = (n) =>
  `00000000-0000-4000-9000-${n.toString(16).padStart(12, "0")}`;
const azBuilds = [];
const azJobs = [];
const azRequests = [];
let azBuildId = 4100;
let azRec = 1;
let azReq = 700_000;
for (let day = 29; day >= 0; day--) {
  // The sync stores runs of linked pipelines only.
  for (const d of azDefs.filter((x) => x.repoId != null)) {
    const count = d.perDay >= 1 ? d.perDay : rand() < d.perDay ? 1 : 0;
    for (let k = 0; k < count; k++) {
      const id = azBuildId++;
      const queued = NOW - day * DAY - between(30, 1300) * MIN;
      if (queued > NOW - 20 * MIN) continue;
      const failed = rand() < d.fail;
      const retried = !failed && rand() < 0.05;
      const wait = between(5, rand() < 0.15 ? 900 : 120);
      const started = queued + wait * 1000;
      const dur = between(d.minS, d.maxS);
      const finished = started + dur * 1000 + (retried ? (dur + 60) * 1000 : 0);
      const pr = rand() < 0.25 ? between(10, 60) : null;
      azBuilds.push({
        installationId: ORG,
        id,
        projectId: AZ_P1,
        definitionId: d.id,
        repositoryId: d.repoId,
        buildNumber: `${new Date(queued).toISOString().slice(0, 10).replaceAll("-", "")}.${k + 1}`,
        status: "COMPLETED",
        result: failed
          ? rand() < 0.3
            ? "PARTIALLY_SUCCEEDED"
            : "FAILED"
          : "SUCCEEDED",
        reason: pr ? "pull_request" : d.id === 14 ? "schedule" : "push",
        headBranch: pr ? `feature/change-${pr}` : "main",
        headSha: hex40(),
        prNumber: pr,
        isDefaultBranch: !pr,
        queuedAt: iso(queued),
        startedAt: iso(started),
        finishedAt: iso(finished),
        durationS: Math.round((finished - started) / 1000),
        queueS: wait,
        maxAttempt: retried ? 2 : 1,
        firstAttemptResult: retried
          ? "FAILED"
          : failed
            ? rand() < 0.3
              ? "PARTIALLY_SUCCEEDED"
              : "FAILED"
            : "SUCCEEDED",
        timedOut: false,
        lastChangedAt: iso(finished),
        timelineSyncedAt: iso(finished + 60_000),
        syncedAt: iso(finished + 60_000),
      });
      const attempts = retried ? [1, 2] : [1];
      for (const attempt of attempts) {
        const base = started + (attempt - 1) * (dur + 60) * 1000;
        const stageRec = recId(azRec++);
        azJobs.push({
          installationId: ORG,
          buildId: id,
          recordId: stageRec,
          attempt,
          type: "Stage",
          projectId: AZ_P1,
          repositoryId: d.repoId,
          identifier: "Build",
          stageIdentifier: "Build",
          name: "Build",
          baseName: "Build",
          state: "completed",
          result: attempt === 1 && (retried || failed) ? "FAILED" : "SUCCEEDED",
          os: "UNKNOWN",
          startedAt: iso(base),
          finishedAt: iso(base + dur * 1000),
          durationS: dur,
          hitJobCap: false,
        });
        let offset = 0;
        for (const [ji, name] of d.jobs.entries()) {
          const jdur = Math.round(dur / d.jobs.length);
          const rec = recId(azRec++);
          const jFailed =
            (attempt === 1 && retried && ji === d.jobs.length - 1) ||
            (failed && ji === d.jobs.length - 1);
          const js = base + offset * 1000;
          azJobs.push({
            installationId: ORG,
            buildId: id,
            recordId: rec,
            attempt,
            type: "Job",
            projectId: AZ_P1,
            repositoryId: d.repoId,
            identifier: `Build.${name}`,
            stageIdentifier: "Build",
            name,
            baseName: name,
            state: "completed",
            result: jFailed ? "FAILED" : "SUCCEEDED",
            poolId: AZ_HOSTED_POOL,
            isHosted: true,
            hostedImage: d.image,
            os: d.os,
            workerName: `Azure Pipelines ${between(1, 9)}`,
            logId: ji + 2,
            queuedAt: iso(queued),
            startedAt: iso(js),
            finishedAt: iso(js + jdur * 1000),
            durationS: jdur,
            queueS: wait,
            hitJobCap: false,
          });
          azRequests.push({
            installationId: ORG,
            poolId: AZ_HOSTED_POOL,
            requestId: BigInt(azReq++),
            projectId: AZ_P1,
            isHosted: true,
            isPrivate: true,
            os: d.os,
            hostedImage: d.image,
            queueTime: iso(queued),
            assignTime: iso(js),
            finishTime: iso(js + jdur * 1000),
            jobId: rec,
            buildId: id,
            result: jFailed ? "failed" : "succeeded",
          });
          offset += jdur;
        }
      }
    }
  }
}
// The newest ios-build on main failed (default branch failing finding).
const iosMain = azBuilds
  .filter((b) => b.definitionId === 12 && b.isDefaultBranch)
  .at(-1);
if (iosMain) {
  iosMain.result = "FAILED";
  iosMain.firstAttemptResult = "FAILED";
  iosMain.maxAttempt = 1;
  for (const j of azJobs) if (j.buildId === iosMain.id) j.result = "FAILED";
}
// A retried ci-linux run that succeeded on attempt 2 (visible in the list).
const retry = azBuilds.find((b) => b.definitionId === 11 && b.maxAttempt === 2);
// One running and one queued run (1/1 parallel job busy, one waiting).
const runningId = azBuildId++;
azBuilds.push({
  installationId: ORG,
  id: runningId,
  projectId: AZ_P1,
  definitionId: 12,
  repositoryId: 202,
  buildNumber: `${new Date(NOW).toISOString().slice(0, 10).replaceAll("-", "")}.9`,
  status: "IN_PROGRESS",
  result: "NONE",
  reason: "push",
  headBranch: "main",
  headSha: hex40(),
  prNumber: null,
  isDefaultBranch: true,
  queuedAt: recent(14),
  startedAt: recent(12),
  finishedAt: null,
  durationS: null,
  queueS: 120,
  maxAttempt: 1,
  firstAttemptResult: null,
  timedOut: false,
  lastChangedAt: recent(3),
  timelineSyncedAt: recent(3),
  syncedAt: recent(3),
});
const runRec = recId(azRec++);
azJobs.push(
  {
    installationId: ORG,
    buildId: runningId,
    recordId: recId(azRec++),
    attempt: 1,
    type: "Stage",
    projectId: AZ_P1,
    repositoryId: 202,
    identifier: "Build",
    stageIdentifier: "Build",
    name: "Build",
    baseName: "Build",
    state: "inProgress",
    result: "NONE",
    os: "UNKNOWN",
    startedAt: recent(12),
    hitJobCap: false,
  },
  {
    installationId: ORG,
    buildId: runningId,
    recordId: runRec,
    attempt: 1,
    type: "Job",
    projectId: AZ_P1,
    repositoryId: 202,
    identifier: "Build.build_ios",
    stageIdentifier: "Build",
    name: "build_ios",
    baseName: "build_ios",
    state: "inProgress",
    result: "NONE",
    poolId: AZ_HOSTED_POOL,
    isHosted: true,
    hostedImage: "macOS-14",
    os: "MACOS",
    workerName: "Azure Pipelines 3",
    logId: 2,
    queuedAt: recent(14),
    startedAt: recent(12),
    queueS: 120,
    hitJobCap: false,
  },
);
azRequests.push({
  installationId: ORG,
  poolId: AZ_HOSTED_POOL,
  requestId: BigInt(azReq++),
  projectId: AZ_P1,
  isHosted: true,
  isPrivate: true,
  os: "MACOS",
  hostedImage: "macOS-14",
  queueTime: recent(14),
  assignTime: recent(12),
  finishTime: null,
  jobId: runRec,
  buildId: runningId,
  result: null,
});
const queuedId = azBuildId++;
azBuilds.push({
  installationId: ORG,
  id: queuedId,
  projectId: AZ_P1,
  definitionId: 11,
  repositoryId: 201,
  buildNumber: `${new Date(NOW).toISOString().slice(0, 10).replaceAll("-", "")}.10`,
  status: "NOT_STARTED",
  result: "NONE",
  reason: "pull_request",
  headBranch: "feature/change-42",
  headSha: hex40(),
  prNumber: 42,
  isDefaultBranch: false,
  queuedAt: recent(6),
  startedAt: null,
  finishedAt: null,
  durationS: null,
  queueS: null,
  queuePosition: 1,
  maxAttempt: 1,
  firstAttemptResult: null,
  timedOut: false,
  lastChangedAt: recent(6),
  syncedAt: recent(3),
});
azRequests.push({
  installationId: ORG,
  poolId: AZ_HOSTED_POOL,
  requestId: BigInt(azReq++),
  projectId: AZ_P1,
  isHosted: true,
  isPrivate: true,
  os: "LINUX",
  hostedImage: "ubuntu-latest",
  queueTime: recent(6),
  assignTime: null,
  finishTime: null,
  jobId: null,
  buildId: queuedId,
  result: null,
});
const azBuildCols = [...new Set(azBuilds.flatMap((r) => Object.keys(r)))];
const azJobCols = [...new Set(azJobs.flatMap((r) => Object.keys(r)))];
await insert("AzureBuild", fill(azBuilds, azBuildCols));
await insert("AzureBuildJob", fill(azJobs, azJobCols));
await insert("AzureJobRequest", azRequests);
await insert("AzurePool", [
  {
    installationId: ORG,
    id: AZ_HOSTED_POOL,
    name: "Azure Pipelines",
    isHosted: true,
    poolType: "automation",
    size: 10,
    sampledAt: recent(4),
  },
  {
    installationId: ORG,
    id: AZ_SELF_POOL,
    name: "self-hosted-pool",
    isHosted: false,
    poolType: "automation",
    size: 2,
    sampledAt: recent(4),
  },
]);
await insert("AzureAgent", [
  {
    installationId: ORG,
    poolId: AZ_SELF_POOL,
    id: 1,
    name: "agent-1",
    status: "online",
    enabled: true,
    version: "4.250.0",
    osDescription: "Linux",
    busy: false,
    statusChangedAt: recent(600),
    sampledAt: recent(4),
  },
  {
    installationId: ORG,
    poolId: AZ_SELF_POOL,
    id: 2,
    name: "agent-2",
    status: "offline",
    enabled: true,
    version: "4.248.0",
    osDescription: "Linux",
    busy: false,
    statusChangedAt: recent(3000),
    sampledAt: recent(4),
  },
]);
const azSamples = [];
for (let m = 24 * 60; m >= 0; m -= 15) {
  const busy = m % 120 < 45 || m < 15 ? 1 : 0;
  azSamples.push({
    installationId: ORG,
    poolId: AZ_HOSTED_POOL,
    at: recent(m + 4),
    running: busy,
    queued: busy && m % 120 < 20 ? between(1, 2) : 0,
    onlineAgents: null,
  });
  azSamples.push({
    installationId: ORG,
    poolId: AZ_SELF_POOL,
    at: recent(m + 4),
    running: 0,
    queued: 0,
    onlineAgents: 1,
  });
}
await insert("AzurePoolSample", azSamples);
// Hosted usage per day (the app computes the same from the job requests).
/** @type {Map<string, Record<string, any>>} */
const azUsage = new Map();
for (const r of azRequests) {
  if (!r.assignTime || !r.finishTime) continue;
  const dayKey = r.assignTime.slice(0, 10);
  const u = azUsage.get(dayKey) ?? {
    installationId: ORG,
    day: dayKey,
    hostedMinutesPrivate: 0,
    hostedMinutesPublic: 0,
    hostedMinutesMacos: 0,
    hostedMinutesLinux: 0,
    hostedMinutesWindows: 0,
    peakParallel: 1,
    saturatedS: between(1200, 7200),
    jobsQueuedOver10m: 0,
    saturationQueueS: 0,
    source: "jobrequests",
  };
  const min = Math.ceil(
    (Date.parse(r.finishTime) - Date.parse(r.assignTime)) / MIN,
  );
  u.hostedMinutesPrivate += min;
  if (r.os === "MACOS") u.hostedMinutesMacos += min;
  else if (r.os === "WINDOWS") u.hostedMinutesWindows += min;
  else u.hostedMinutesLinux += min;
  const waited = (Date.parse(r.assignTime) - Date.parse(r.queueTime)) / 1000;
  if (waited > 600) u.jobsQueuedOver10m++;
  if (waited > 60) u.saturationQueueS += Math.round(waited);
  azUsage.set(dayKey, u);
}
await insert("DailyAzureUsage", [...azUsage.values()]);
const monthKey = new Date(NOW).toISOString().slice(0, 7);
const monthUsed = [...azUsage.values()]
  .filter((u) => u.day.startsWith(monthKey))
  .reduce((s, u) => s + u.hostedMinutesPrivate, 0);
await insert("AzureUsageSnapshot", [
  {
    installationId: ORG,
    month: monthKey,
    source: "api",
    usedMinutes: Math.round(monthUsed * 1.08),
    totalMinutes: 1800,
    usedParallel: 1,
    totalParallel: 1,
    isPremium: false,
    capturedAt: recent(30),
  },
  {
    installationId: ORG,
    month: monthKey,
    source: "estimate",
    usedMinutes: monthUsed,
    totalMinutes: 1800,
    usedParallel: 1,
    totalParallel: 1,
    isPremium: null,
    capturedAt: recent(4),
  },
]);
// Daily pipeline stats: the same DELETE + INSERT … SELECT as the app (azure-rollup.ts).
await client.query(`
  INSERT INTO "DailyPipelineStat" (
    "installationId", "projectId", "definitionId", "day", "defaultBranch", "repositoryId",
    "builds", "succeeded", "partial", "failed", "canceled", "timedOut",
    "firstTrySuccess", "flakyRecovered", "durSumS", "durationHist", "queueHist",
    "jobSecondsHostedLinux", "jobSecondsHostedWindows", "jobSecondsHostedMacos",
    "jobSecondsSelfHosted", "jobsNearCap")
  SELECT b."installationId", b."projectId", b."definitionId", (b."queuedAt" AT TIME ZONE 'UTC')::date, b."isDefaultBranch", max(b."repositoryId"),
    count(*)::int,
    count(*) FILTER (WHERE b."result" = 'SUCCEEDED')::int,
    count(*) FILTER (WHERE b."result" = 'PARTIALLY_SUCCEEDED')::int,
    count(*) FILTER (WHERE b."result" = 'FAILED')::int,
    count(*) FILTER (WHERE b."result" = 'CANCELED')::int,
    0,
    count(*) FILTER (WHERE b."firstAttemptResult" = 'SUCCEEDED')::int,
    count(*) FILTER (WHERE b."maxAttempt" > 1 AND b."result" = 'SUCCEEDED')::int,
    COALESCE(sum(b."durationS"), 0)::bigint, hist_agg(b."durationS"), hist_agg(b."queueS"),
    COALESCE(sum(j.linux), 0)::int, COALESCE(sum(j.windows), 0)::int, COALESCE(sum(j.macos), 0)::int, 0,
    COALESCE(sum(j.near), 0)::int
  FROM "AzureBuild" b
  LEFT JOIN LATERAL (
    SELECT sum("durationS") FILTER (WHERE "os" = 'LINUX') AS linux,
           sum("durationS") FILTER (WHERE "os" = 'WINDOWS') AS windows,
           sum("durationS") FILTER (WHERE "os" = 'MACOS') AS macos,
           count(*) FILTER (WHERE "durationS" >= 3000) AS near
    FROM "AzureBuildJob" WHERE "installationId" = b."installationId" AND "buildId" = b."id" AND "type" = 'Job'
  ) j ON true
  WHERE b."installationId" = ${ORG} AND b."status" = 'COMPLETED'
  GROUP BY 1, 2, 3, 4, 5`);
/** @param {string} ruleKey @param {string} source @param {string} severity @param {string} title @param {Record<string, string | number | null>} details @param {string | null} url */
const azFinding = (ruleKey, source, severity, title, details, url) => ({
  id: `finding-${ruleKey.replace(/[^a-z0-9]/gi, "-")}`,
  installationId: ORG,
  repositoryId: null,
  source,
  ruleKey,
  severity,
  status: "OPEN",
  title,
  externalUrl: url,
  details: JSON.stringify(details),
  firstSeenAt: iso(NOW - 3 * 3_600_000),
  lastSeenAt: recent(4),
});
/** @param {number} id */
const azDefUrl = (id) =>
  `https://dev.azure.com/contoso-ci/${AZ_P1}/_build?definitionId=${id}`;
await insert("Finding", [
  azFinding(
    `azure:default-failing:${AZ_P1}:12`,
    "AZURE_PIPELINES",
    "HIGH",
    "ios-build: default branch pipeline failing",
    {
      kind: "azure_default_failing",
      projectName: "ios-build",
      definitionId: 12,
      projectId: AZ_P1,
      buildId: iosMain?.id ?? null,
      repositoryId: "202",
    },
    azDefUrl(12),
  ),
  azFinding(
    `azure:job-cap:${AZ_P1}:14`,
    "AZURE_PIPELINES",
    "MEDIUM",
    "nightly-e2e: jobs near the 60-minute limit",
    {
      kind: "azure_job_cap",
      projectName: "nightly-e2e",
      definitionId: 14,
      projectId: AZ_P1,
      p90Minutes: 58,
      capMinutes: 60,
      hits: 0,
      repositoryId: "201",
    },
    azDefUrl(14),
  ),
  azFinding(
    `azure:minutes:${monthKey}`,
    "AZURE_PIPELINES",
    "MEDIUM",
    `Azure Pipelines minutes: ${Math.round(monthUsed * 1.08)} of 1800`,
    {
      kind: "azure_minutes",
      used: Math.round(monthUsed * 1.08),
      included: 1800,
      month: monthKey,
      source: "api",
    },
    "https://dev.azure.com/contoso-ci",
  ),
  azFinding(
    `azure:definition-unlinked:${AZ_P1}:15`,
    "AZURE_PIPELINES",
    "LOW",
    "legacy-app: repository not in this installation",
    {
      kind: "azure_definition_unlinked",
      projectName: "legacy-app",
      definitionId: 15,
      projectId: AZ_P1,
      linkRepo: "example-other/legacy-app",
    },
    azDefUrl(15),
  ),
]);
console.log(
  `seeded ${azBuilds.length} Azure pipeline runs (retried run ${retry?.id ?? "none"}), ${azJobs.length} job rows, ${azRequests.length} job requests, ${monthUsed} hosted minutes this month`,
);

// ---------- audit: the M6 actions of example-org, hash-chained ----------
// Computed like src/server/audit/chain.ts, so "Verify chain" succeeds.
/** @param {unknown} v @returns {string} */
const canonical = (v) => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const entries = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
};
/** @param {unknown} fields @param {string} prev */
const chainHash = (fields, prev) =>
  createHash("sha256").update(canonical(fields)).update(prev).digest("hex");
const projectBLive = liveOf.get("prj_demo00000000000000002");
const auditEntries = [
  {
    id: AUDIT_TOGGLE,
    at: NOW - 6 * 3_600_000,
    actorRole: "ADMIN",
    actingAs: null,
    action: "VERCEL_MANAGEMENT_TOGGLE",
    repositoryId: null,
    repoFullName: null,
    targetType: "vercel_team",
    targetId: String(ORG),
    params: { teamSlug: "example-team", before: false, after: true },
    httpStatus: null,
    requestId: null,
  },
  {
    id: AUDIT_ROLLBACK,
    at: NOW - 5 * 3_600_000,
    actorRole: "OPERATOR",
    actingAs: "vercel:token:a1b2",
    action: "VERCEL_ROLLBACK",
    repositoryId: 202n,
    repoFullName: "example-org/repo-b",
    targetType: "vercel_deployment",
    targetId: projectBLive,
    params: {
      projectId: "prj_demo00000000000000002",
      deploymentId: projectBLive,
      target: "production",
    },
    httpStatus: 201,
    requestId: "fra1::demo-rollback",
  },
  {
    id: AUDIT_REDEPLOY,
    at: NOW - 25 * MIN - 2_000,
    actorRole: "OPERATOR",
    actingAs: "vercel:token:a1b2",
    action: "VERCEL_REDEPLOY",
    repositoryId: 203n,
    repoFullName: "example-org/repo-c",
    targetType: "vercel_deployment",
    targetId: "dpl_demo_redeployed_preview",
    params: {
      projectId: "prj_demo00000000000000003",
      deploymentId: "dpl_demo_redeployed_preview",
      target: "preview",
      withLatestCommit: false,
    },
    httpStatus: 200,
    requestId: "fra1::demo-redeploy",
  },
];
let prevHash = "0".repeat(64);
let headSeq = 0n;
for (const a of auditEntries) {
  const immutable = {
    id: a.id,
    installationId: ORG,
    actorUserId: "demo-operator",
    actorDisplay: "Demo operator",
    actorRole: a.actorRole,
    actorProvider: "oidc",
    actingAs: a.actingAs,
    action: a.action,
    repositoryId: a.repositoryId,
    repoFullName: a.repoFullName,
    targetType: a.targetType,
    targetId: a.targetId,
    batchId: null,
    params: a.params,
    confirmation: a.action === "VERCEL_REDEPLOY" ? "DIALOG" : "TYPED",
    idempotencyKey: `demo-${a.id}`,
    createdAt: new Date(a.at),
  };
  const hash = chainHash(immutable, prevHash);
  const final = {
    status: "SUCCEEDED",
    httpStatus: a.httpStatus,
    githubRequestId: a.requestId,
    error: null,
    completedAt: new Date(a.at + 1_500),
  };
  const { rows } = await client.query(
    `INSERT INTO "AuditLog" ("id", "installationId", "actorUserId", "actorDisplay", "actorRole",
       "actorProvider", "actingAs", "action", "repositoryId", "repoFullName", "targetType", "targetId",
       "batchId", "params", "confirmation", "idempotencyKey", "status", "httpStatus", "githubRequestId",
       "error", "prevHash", "hash", "resultHash", "createdAt", "completedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     RETURNING "seq"`,
    [
      immutable.id,
      immutable.installationId,
      immutable.actorUserId,
      immutable.actorDisplay,
      immutable.actorRole,
      immutable.actorProvider,
      immutable.actingAs,
      immutable.action,
      immutable.repositoryId,
      immutable.repoFullName,
      immutable.targetType,
      immutable.targetId,
      null,
      JSON.stringify(immutable.params),
      immutable.confirmation,
      immutable.idempotencyKey,
      final.status,
      final.httpStatus,
      final.githubRequestId,
      null,
      prevHash,
      hash,
      chainHash(final, hash),
      immutable.createdAt.toISOString(),
      final.completedAt.toISOString(),
    ],
  );
  prevHash = hash;
  headSeq = BigInt(rows[0].seq);
}
await client.query(
  `INSERT INTO "AuditChainHead" ("installationId", "seq", "hash", "sealedAfterSeq", "updatedAt")
   VALUES ($1, $2, $3, 0, now())`,
  [ORG, headSeq, prevHash],
);

console.log(
  `seeded ${repos.length} repositories, ${runs.length} runs, ${jobs.length} jobs, ${samples.length} runner samples, ${billing.length} billing items, ${deployments.length} Vercel deployments`,
);

if (appUrl) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("--app needs CRON_SECRET");
    process.exit(1);
  }
  for (let i = 0; i < 10; i++) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM "RollupDirty"`,
    );
    if (rows[0].n === 0) break;
    console.log(`computing daily summaries (${rows[0].n} left)…`);
    const res = await fetch(`${appUrl}/api/cron/reconcile`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!res.ok) console.warn(`cron answered ${res.status}`);
  }
  // Reconcile cannot reach GitHub with demo credentials; keep a fresh state.
  await client.query(
    `UPDATE "Installation" SET "lastReconcileStatus" = 'ok', "lastReconcileReason" = NULL,
       "lastReconciledAt" = now() - interval '12 minutes', "lastWebhookAt" = now() - interval '3 minutes'`,
  );
}
await client.end();
