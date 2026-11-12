import type { AuditEntryDto } from "@/server/data/audit";
import type { AlertRow } from "@/server/data/dependabot";
import type { PullRow } from "@/server/data/pulls";
import type { RepoVariables } from "@/server/data/variables";
import type { RunActionTarget } from "./run-actions";

/** Synthetic DTOs for the management component tests. */

export const run = (r: Partial<RunActionTarget> = {}): RunActionTarget => ({
  id: "9001",
  repoFullName: "example-org/repo-a",
  workflowName: "CI",
  runNumber: 12,
  runAttempt: 1,
  status: "COMPLETED",
  conclusion: "FAILURE",
  ...r,
});

export const pull = (p: Partial<PullRow> = {}): PullRow => ({
  repositoryId: "101",
  repoFullName: "example-org/repo-a",
  number: 7,
  title: "Bump actions/checkout from 4 to 5",
  url: "https://github.com/example-org/repo-a/pull/7",
  author: "dependabot",
  isDependabot: true,
  isDraft: false,
  createdAt: "2026-11-10T12:00:00Z",
  headSha: "a".repeat(40),
  headRef: "dependabot/github_actions/actions/checkout-5",
  baseRef: "main",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  checks: "SUCCESS",
  changesWorkflows: false,
  labels: [],
  ...p,
});

export const repoVars = (r: Partial<RepoVariables> = {}): RepoVariables => ({
  repositoryId: "101",
  fullName: "example-org/repo-a",
  archived: false,
  status: "ok",
  variables: {
    LINUX_RUNNER: {
      value: "runner-1",
      masked: false,
      updatedAt: "2026-11-01T00:00:00Z",
    },
  },
  ...r,
});

export const alert = (a: Partial<AlertRow> = {}): AlertRow => ({
  repositoryId: "101",
  repoFullName: "example-org/repo-a",
  number: 3,
  severity: "high",
  packageName: "example-lib",
  ecosystem: "npm",
  manifestPath: "package-lock.json",
  ghsaId: "GHSA-xxxx-yyyy-zzzz",
  cveId: null,
  summary: "Example advisory",
  fixedIn: "1.2.3",
  htmlUrl: "https://github.com/example-org/repo-a/security/dependabot/3",
  createdAt: "2026-11-01T00:00:00Z",
  ...a,
});

export const auditEntry = (e: Partial<AuditEntryDto> = {}): AuditEntryDto => ({
  id: "audit-1",
  seq: "41",
  createdAt: "2026-11-11T10:00:00Z",
  completedAt: "2026-11-11T10:00:01Z",
  actorUserId: "user-1",
  actorDisplay: "Example User",
  actorRole: "ADMIN",
  actorProvider: "oidc",
  actingAs: "app:example-app[bot]",
  action: "VAR_BULK",
  status: "SUCCEEDED",
  repositoryId: null,
  repoFullName: null,
  targetType: "batch",
  targetId: "0b6c6f3e-8a43-4c1e-9d9b-4b8d2a1f0c11",
  batchId: "0b6c6f3e-8a43-4c1e-9d9b-4b8d2a1f0c11",
  params: { name: "LINUX_RUNNER" },
  confirmation: "TYPED",
  httpStatus: null,
  githubRequestId: null,
  error: null,
  ...e,
});
