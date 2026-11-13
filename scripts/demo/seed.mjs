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
// rolled-back production) and findings.
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
  console.error(`refusing to seed a non-local database (${host})`);
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
    "FeatureAvailability", "Repository", "Installation" CASCADE`);

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
    events: "{workflow_run,workflow_job}",
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
        headSha: createHash("sha1").update(`run-${id_}`).digest("hex"),
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
  createHash("sha1").update(`synthetic-${repoId}`).digest("hex");
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
