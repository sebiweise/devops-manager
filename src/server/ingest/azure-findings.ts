import "server-only";
import { projectWindow, quotaLevel } from "@/lib/azure-usage";
import { azureDefinitionUrl, azureOrgUrl } from "@/server/azure/client";
import { db } from "@/server/db";
import { percentileExact } from "@/server/metrics/stats";
import { estimateMonthMinutes } from "./azure-usage";
import { raiseFinding, resolveFindings } from "./provider-step";

/**
 * Azure Pipelines findings (design addendum M7 §5.4), DB only, written by
 * step z7 (and after credential changes). Source AZURE_PIPELINES; the
 * credential findings stay under CREDENTIAL. Rule keys are stable, so a
 * dismissed finding stays dismissed and a fixed one opens again.
 *
 * | ruleKey                                 | raised when                                         |
 * | azure:default-failing:<p>:<def>         | the latest default-branch build failed (partial: MEDIUM) |
 * | azure:job-cap:<p>:<def>                 | job p90 over 7 d > cap − 10 min (HIGH after a cap hit); resolved below cap − 15 min without hits |
 * | azure:minutes:<yyyy-mm>                 | ≥ 80 % or projected > 100 % with ≥ 7 d left (MEDIUM), ≥ 100 % (HIGH) |
 * | azure:parallel-saturated                | ≥ 3 jobs queued > 10 min while saturated within 7 d |
 * | azure:pool-offline:<poolId>             | a self-hosted pool has no agent online while jobs wait |
 * | azure:hook-disabled:<subId>             | one of our service hook subscriptions is not enabled |
 * | azure:definition-unlinked:<p>:<def>     | a GitHub definition whose repo is not in this installation |
 * | azure:credential-revoked / token-expiring (CREDENTIAL) | 401/203/rejected secret / expiry ≤ 14 d |
 */

const DAY_MS = 86_400_000;
const EXPIRY_WARN_MS = 14 * DAY_MS;

type Def = {
  projectId: string;
  id: number;
  name: string;
  repoType: string;
  linkRepoFullName: string | null;
  repositoryId: bigint | null;
  manualRepositoryId: bigint | null;
  defaultBranch: string | null;
};

const repoOf = (d: Def) => d.manualRepositoryId ?? d.repositoryId;
const repoDetail = (d: Def) => {
  const r = repoOf(d);
  return r != null ? String(r) : null;
};

export async function updateAzureFindings(
  installationId: bigint,
  timezone: string,
  now: Date,
): Promise<void> {
  const conn = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: {
      orgName: true,
      includedMinutes: true,
      maxJobMinutes: true,
      monthResetDay: true,
      hostedParallelJobs: true,
    },
  });
  if (!conn) return;
  const org = conn.orgName;
  const defs: Def[] = await db.azurePipelineDefinition.findMany({
    where: { installationId, removedAt: null },
    select: {
      projectId: true,
      id: true,
      name: true,
      repoType: true,
      linkRepoFullName: true,
      repositoryId: true,
      manualRepositoryId: true,
      defaultBranch: true,
    },
  });
  const selected = new Set(
    (
      await db.azureDevOpsProject.findMany({
        where: { installationId, selected: true, removedAt: null },
        select: { id: true },
      })
    ).map((p) => p.id),
  );

  // default-failing and job-cap per linked definition.
  const failing: string[] = [];
  const cap: string[] = [];
  const capMin = conn.maxJobMinutes;
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const openCap = new Set(
    (
      await db.finding.findMany({
        where: {
          installationId,
          source: "AZURE_PIPELINES",
          status: { in: ["OPEN", "DISMISSED"] },
          ruleKey: { startsWith: "azure:job-cap:" },
        },
        select: { ruleKey: true },
      })
    ).map((f) => f.ruleKey),
  );
  for (const d of defs) {
    if (repoOf(d) == null) continue;
    const latest = await db.azureBuild.findFirst({
      where: {
        installationId,
        projectId: d.projectId,
        definitionId: d.id,
        status: "COMPLETED",
        isDefaultBranch: true,
        result: { not: "NONE" },
      },
      orderBy: { queuedAt: "desc" },
      select: { id: true, result: true, timedOut: true },
    });
    if (
      latest &&
      (latest.result === "FAILED" ||
        latest.result === "PARTIALLY_SUCCEEDED" ||
        latest.timedOut)
    ) {
      const ruleKey = `azure:default-failing:${d.projectId}:${d.id}`;
      failing.push(ruleKey);
      await raiseFinding(
        installationId,
        {
          source: "AZURE_PIPELINES",
          ruleKey,
          repositoryId: null,
          severity: latest.result === "PARTIALLY_SUCCEEDED" ? "MEDIUM" : "HIGH",
          title: `${d.name}: default branch pipeline failing`,
          externalUrl: azureDefinitionUrl(org, d.projectId, d.id),
          details: {
            kind: "azure_default_failing",
            projectName: d.name,
            definitionId: d.id,
            projectId: d.projectId,
            buildId: latest.id,
            partial: latest.result === "PARTIALLY_SUCCEEDED",
            repositoryId: repoDetail(d),
          },
        },
        now,
      );
    }
    const jobs = await db.azureBuildJob.findMany({
      where: {
        installationId,
        type: "Job",
        startedAt: { gte: weekAgo },
        durationS: { not: null },
        buildId: {
          in: (
            await db.azureBuild.findMany({
              where: {
                installationId,
                projectId: d.projectId,
                definitionId: d.id,
                queuedAt: { gte: weekAgo },
              },
              select: { id: true },
              take: 2000,
            })
          ).map((b) => b.id),
        },
      },
      select: { durationS: true, hitJobCap: true },
    });
    const p90 = percentileExact(
      jobs.map((j) => j.durationS!),
      0.9,
    );
    const hits = jobs.filter((j) => j.hitJobCap).length;
    const ruleKey = `azure:job-cap:${d.projectId}:${d.id}`;
    const p90Min = p90 == null ? 0 : p90 / 60;
    const raise =
      hits > 0 ||
      p90Min > capMin - 10 ||
      // Hysteresis: an open finding resolves only below cap − 15 min.
      (openCap.has(ruleKey) && p90Min >= capMin - 15);
    if (jobs.length > 0 && raise) {
      cap.push(ruleKey);
      await raiseFinding(
        installationId,
        {
          source: "AZURE_PIPELINES",
          ruleKey,
          repositoryId: null,
          severity: hits > 0 ? "HIGH" : "MEDIUM",
          title: `${d.name}: jobs near the ${capMin}-minute limit`,
          externalUrl: azureDefinitionUrl(org, d.projectId, d.id),
          details: {
            kind: "azure_job_cap",
            projectName: d.name,
            definitionId: d.id,
            projectId: d.projectId,
            p90Minutes: Math.round(p90Min),
            capMinutes: capMin,
            hits,
            repositoryId: repoDetail(d),
          },
        },
        now,
      );
    }
  }
  await resolveFindings(
    installationId,
    "AZURE_PIPELINES",
    "azure:default-failing:",
    failing,
    now,
  );
  await resolveFindings(
    installationId,
    "AZURE_PIPELINES",
    "azure:job-cap:",
    cap,
    now,
  );

  // Unlinked GitHub definitions of the selected projects.
  const unlinked: string[] = [];
  for (const d of defs) {
    if (
      !selected.has(d.projectId) ||
      d.repoType.toLowerCase() !== "github" ||
      repoOf(d) != null
    )
      continue;
    const ruleKey = `azure:definition-unlinked:${d.projectId}:${d.id}`;
    unlinked.push(ruleKey);
    await raiseFinding(
      installationId,
      {
        source: "AZURE_PIPELINES",
        ruleKey,
        repositoryId: null,
        severity: "LOW",
        title: `${d.name}: repository not in this installation`,
        externalUrl: azureDefinitionUrl(org, d.projectId, d.id),
        details: {
          kind: "azure_definition_unlinked",
          projectName: d.name,
          definitionId: d.id,
          projectId: d.projectId,
          linkRepo: d.linkRepoFullName,
        },
      },
      now,
    );
  }
  await resolveFindings(
    installationId,
    "AZURE_PIPELINES",
    "azure:definition-unlinked:",
    unlinked,
    now,
  );

  // Minutes against the included minutes of the billing month.
  const minutesKeep: string[] = [];
  if (conn.includedMinutes != null) {
    const est = await estimateMonthMinutes(
      installationId,
      timezone,
      conn.monthResetDay,
      now,
    );
    const api = await db.azureUsageSnapshot.findUnique({
      where: {
        installationId_month_source: {
          installationId,
          month: est.month.key,
          source: "api",
        },
      },
      select: { usedMinutes: true },
    });
    const used = api?.usedMinutes ?? est.minutes;
    const projected = projectWindow(used, est.month);
    const level = quotaLevel(
      used,
      conn.includedMinutes,
      projected,
      est.month.daysLeft,
    );
    if (level === "warning" || level === "exceeded") {
      const ruleKey = `azure:minutes:${est.month.key}`;
      minutesKeep.push(ruleKey);
      await raiseFinding(
        installationId,
        {
          source: "AZURE_PIPELINES",
          ruleKey,
          repositoryId: null,
          severity: level === "exceeded" ? "HIGH" : "MEDIUM",
          title: `Azure Pipelines minutes: ${used} of ${conn.includedMinutes}`,
          externalUrl: azureOrgUrl(org),
          details: {
            kind: "azure_minutes",
            used,
            included: conn.includedMinutes,
            projected: Math.round(projected),
            month: est.month.key,
            source: api ? "api" : "estimate",
          },
        },
        now,
      );
    }
  }
  await resolveFindings(
    installationId,
    "AZURE_PIPELINES",
    "azure:minutes:",
    minutesKeep,
    now,
  );

  // Parallel saturation within 7 days.
  const sat = await db.dailyAzureUsage.aggregate({
    where: {
      installationId,
      day: { gte: new Date(now.getTime() - 7 * DAY_MS) },
    },
    _sum: { jobsQueuedOver10m: true, saturatedS: true },
  });
  const satKeep: string[] = [];
  if (
    (sat._sum.jobsQueuedOver10m ?? 0) >= 3 &&
    (sat._sum.saturatedS ?? 0) > 0
  ) {
    satKeep.push("azure:parallel-saturated");
    await raiseFinding(
      installationId,
      {
        source: "AZURE_PIPELINES",
        ruleKey: "azure:parallel-saturated",
        repositoryId: null,
        severity: "LOW",
        title: "Azure Pipelines jobs waited for a parallel job",
        externalUrl: azureOrgUrl(org),
        details: {
          kind: "azure_parallel_saturated",
          jobs: sat._sum.jobsQueuedOver10m ?? 0,
          parallel: conn.hostedParallelJobs,
        },
      },
      now,
    );
  }
  await resolveFindings(
    installationId,
    "AZURE_PIPELINES",
    "azure:parallel-saturated",
    satKeep,
    now,
  );

  // Self-hosted pools without an online agent while jobs wait.
  const pools = await db.azurePool.findMany({
    where: { installationId, isHosted: false, removedAt: null },
    select: { id: true, name: true },
  });
  const offline: string[] = [];
  for (const p of pools) {
    const s = await db.azurePoolSample.findFirst({
      where: { installationId, poolId: p.id },
      orderBy: { at: "desc" },
      select: { queued: true, onlineAgents: true },
    });
    if (!s || s.queued === 0 || (s.onlineAgents ?? 0) > 0) continue;
    const ruleKey = `azure:pool-offline:${p.id}`;
    offline.push(ruleKey);
    await raiseFinding(
      installationId,
      {
        source: "AZURE_PIPELINES",
        ruleKey,
        repositoryId: null,
        severity: "HIGH",
        title: `${p.name}: no agent online, ${s.queued} job(s) waiting`,
        externalUrl: azureOrgUrl(org),
        details: {
          kind: "azure_pool_offline",
          projectName: p.name,
          poolId: p.id,
          queued: s.queued,
        },
      },
      now,
    );
  }
  await resolveFindings(
    installationId,
    "AZURE_PIPELINES",
    "azure:pool-offline:",
    offline,
    now,
  );

  // Our service hook subscriptions that are not enabled.
  const subs = await db.azureHookSubscription.findMany({
    where: { installationId },
    select: { id: true, status: true, eventType: true },
  });
  const hooks: string[] = [];
  for (const s of subs) {
    if (s.status === "enabled") continue;
    const ruleKey = `azure:hook-disabled:${s.id}`;
    hooks.push(ruleKey);
    await raiseFinding(
      installationId,
      {
        source: "AZURE_PIPELINES",
        ruleKey,
        repositoryId: null,
        severity: "MEDIUM",
        title: `Azure DevOps service hook ${s.status}`,
        externalUrl: azureOrgUrl(org),
        details: {
          kind: "azure_hook_disabled",
          status: s.status,
          eventType: s.eventType,
        },
      },
      now,
    );
  }
  await resolveFindings(
    installationId,
    "AZURE_PIPELINES",
    "azure:hook-disabled:",
    hooks,
    now,
  );
}

/** Credential findings: revoked (401, 203, rejected secret) or expiring within 14 days. */
export async function updateAzureCredentialFindings(
  installationId: bigint,
  now: Date,
): Promise<void> {
  const conn = await db.azureDevOpsConnection.findUnique({
    where: { installationId },
    select: { revokedAt: true, tokenExpiresAt: true, authKind: true },
  });
  const keep: string[] = [];
  if (conn?.revokedAt) {
    keep.push("azure:credential-revoked");
    await raiseFinding(
      installationId,
      {
        source: "CREDENTIAL",
        ruleKey: "azure:credential-revoked",
        repositoryId: null,
        severity: "HIGH",
        title: "Azure DevOps rejected the credential; reconnect required",
        externalUrl: null,
        details: {
          kind: "azure_credential_revoked",
          since: conn.revokedAt.toISOString(),
          authKind: conn.authKind,
        },
      },
      now,
    );
  } else if (
    conn?.tokenExpiresAt &&
    conn.tokenExpiresAt.getTime() - now.getTime() < EXPIRY_WARN_MS
  ) {
    keep.push("azure:token-expiring");
    await raiseFinding(
      installationId,
      {
        source: "CREDENTIAL",
        ruleKey: "azure:token-expiring",
        repositoryId: null,
        severity: conn.tokenExpiresAt <= now ? "HIGH" : "MEDIUM",
        title: "Azure DevOps credential expires soon",
        externalUrl: null,
        details: {
          kind: "azure_token_expiring",
          expiresAt: conn.tokenExpiresAt.toISOString(),
          authKind: conn.authKind,
        },
      },
      now,
    );
  }
  await resolveFindings(installationId, "CREDENTIAL", "azure:", keep, now);
}
