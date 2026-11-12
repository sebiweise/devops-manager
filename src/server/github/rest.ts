import type { GitHubApi } from "@/server/ingest/github-client";
import { githubErrorInfo, requestIdOf } from "./errors";

/**
 * Thin REST wrappers for the management endpoints (design §8.2). They take
 * an installation-token client from the token broker; which token (and so
 * which permissions and repos) is the caller's decision.
 */

export type Repo = { ownerLogin: string; name: string };

export type Written = { httpStatus: number; requestId: string | null };

const written = (res: {
  status: number;
  headers: Record<string, string | number | undefined>;
}): Written => ({
  httpStatus: res.status,
  requestId: requestIdOf(res.headers),
});

// ---------- runs ----------

export type RunOperation = "rerun" | "rerun_failed" | "cancel" | "force_cancel";

const RUN_ROUTES: Record<RunOperation, string> = {
  rerun: "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun",
  rerun_failed:
    "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs",
  cancel: "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel",
  force_cancel: "POST /repos/{owner}/{repo}/actions/runs/{run_id}/force-cancel",
};

export async function runOperation(
  api: GitHubApi,
  repo: Repo,
  runId: bigint,
  op: RunOperation,
  enableDebugLogging = false,
): Promise<Written> {
  const res = await api.request(RUN_ROUTES[op], {
    owner: repo.ownerLogin,
    repo: repo.name,
    run_id: Number(runId),
    ...((op === "rerun" || op === "rerun_failed") && enableDebugLogging
      ? { enable_debug_logging: true }
      : {}),
  });
  return written(res);
}

export type LiveRun = {
  status: string | null;
  conclusion: string | null;
  runAttempt: number | null;
};

/** Re-reads a run after an action; null when GitHub cannot be read. */
export async function getRun(
  api: GitHubApi,
  repo: Repo,
  runId: bigint,
): Promise<LiveRun | null> {
  try {
    const res = await api.request<{
      status?: string | null;
      conclusion?: string | null;
      run_attempt?: number;
    }>("GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
      owner: repo.ownerLogin,
      repo: repo.name,
      run_id: Number(runId),
    });
    return {
      status: res.data.status ?? null,
      conclusion: res.data.conclusion ?? null,
      runAttempt: res.data.run_attempt ?? null,
    };
  } catch {
    return null;
  }
}

// ---------- repository variables ----------

export type GhVariable = {
  name: string;
  value: string;
  created_at?: string;
  updated_at?: string;
};

/** The current value, or null when the variable does not exist. */
export async function getRepoVariable(
  api: GitHubApi,
  repo: Repo,
  name: string,
): Promise<string | null> {
  try {
    const res = await api.request<GhVariable>(
      "GET /repos/{owner}/{repo}/actions/variables/{name}",
      { owner: repo.ownerLogin, repo: repo.name, name },
    );
    return res.data.value;
  } catch (error) {
    if (githubErrorInfo(error).status === 404) return null;
    throw error;
  }
}

export async function listRepoVariables(
  api: GitHubApi,
  repo: Repo,
): Promise<GhVariable[]> {
  const out: GhVariable[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await api.request<{
      total_count: number;
      variables: GhVariable[];
    }>("GET /repos/{owner}/{repo}/actions/variables", {
      owner: repo.ownerLogin,
      repo: repo.name,
      per_page: 30,
      page,
    });
    out.push(...res.data.variables);
    if (res.data.variables.length < 30 || out.length >= res.data.total_count)
      break;
  }
  return out;
}

/** PATCH when the variable exists, POST otherwise (design §8.2 #5). */
export async function writeRepoVariable(
  api: GitHubApi,
  repo: Repo,
  name: string,
  value: string,
  exists: boolean,
): Promise<Written> {
  const res = exists
    ? await api.request(
        "PATCH /repos/{owner}/{repo}/actions/variables/{name}",
        {
          owner: repo.ownerLogin,
          repo: repo.name,
          name,
          value,
        },
      )
    : await api.request("POST /repos/{owner}/{repo}/actions/variables", {
        owner: repo.ownerLogin,
        repo: repo.name,
        name,
        value,
      });
  return written(res);
}

export async function deleteRepoVariable(
  api: GitHubApi,
  repo: Repo,
  name: string,
): Promise<Written> {
  return written(
    await api.request("DELETE /repos/{owner}/{repo}/actions/variables/{name}", {
      owner: repo.ownerLogin,
      repo: repo.name,
      name,
    }),
  );
}

// ---------- organisation variables ----------

export type OrgVisibility = "all" | "private" | "selected";

export type GhOrgVariable = GhVariable & { visibility: OrgVisibility };

export async function getOrgVariable(
  api: GitHubApi,
  org: string,
  name: string,
): Promise<GhOrgVariable | null> {
  try {
    const res = await api.request<GhOrgVariable>(
      "GET /orgs/{org}/actions/variables/{name}",
      { org, name },
    );
    return res.data;
  } catch (error) {
    if (githubErrorInfo(error).status === 404) return null;
    throw error;
  }
}

export async function listOrgVariables(
  api: GitHubApi,
  org: string,
): Promise<GhOrgVariable[]> {
  const out: GhOrgVariable[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await api.request<{
      total_count: number;
      variables: GhOrgVariable[];
    }>("GET /orgs/{org}/actions/variables", { org, per_page: 30, page });
    out.push(...res.data.variables);
    if (res.data.variables.length < 30 || out.length >= res.data.total_count)
      break;
  }
  return out;
}

/** Every repository selected for an org variable, through all pages. */
export async function listOrgVariableRepos(
  api: GitHubApi,
  org: string,
  name: string,
): Promise<number[]> {
  const out: number[] = [];
  for (let page = 1; page <= 100; page++) {
    const res = await api.request<{
      total_count: number;
      repositories: Array<{ id: number }>;
    }>("GET /orgs/{org}/actions/variables/{name}/repositories", {
      org,
      name,
      per_page: 100,
      page,
    });
    out.push(...res.data.repositories.map((r) => r.id));
    if (
      res.data.repositories.length < 100 ||
      out.length >= res.data.total_count
    )
      return out;
  }
  throw new Error("organisation variable has too many selected repositories");
}

/** Adds one repository to an org variable's selection, leaving the others. */
export async function addOrgVariableRepo(
  api: GitHubApi,
  org: string,
  name: string,
  repositoryId: number,
): Promise<Written> {
  return written(
    await api.request(
      "PUT /orgs/{org}/actions/variables/{name}/repositories/{repository_id}",
      { org, name, repository_id: repositoryId },
    ),
  );
}

/** Removes one repository from an org variable's selection. */
export async function removeOrgVariableRepo(
  api: GitHubApi,
  org: string,
  name: string,
  repositoryId: number,
): Promise<Written> {
  return written(
    await api.request(
      "DELETE /orgs/{org}/actions/variables/{name}/repositories/{repository_id}",
      { org, name, repository_id: repositoryId },
    ),
  );
}

export async function writeOrgVariable(
  api: GitHubApi,
  org: string,
  input: {
    name: string;
    value: string;
    visibility: OrgVisibility;
    /**
     * Replaces the whole selection. Leave it out to keep GitHub's current
     * selection (PATCH only).
     */
    selectedRepositoryIds?: number[];
  },
  exists: boolean,
): Promise<Written> {
  const body = {
    org,
    name: input.name,
    value: input.value,
    visibility: input.visibility,
    ...(input.visibility === "selected" &&
    (input.selectedRepositoryIds !== undefined || !exists)
      ? { selected_repository_ids: input.selectedRepositoryIds ?? [] }
      : {}),
  };
  return written(
    exists
      ? await api.request("PATCH /orgs/{org}/actions/variables/{name}", body)
      : await api.request("POST /orgs/{org}/actions/variables", body),
  );
}

export async function deleteOrgVariable(
  api: GitHubApi,
  org: string,
  name: string,
): Promise<Written> {
  return written(
    await api.request("DELETE /orgs/{org}/actions/variables/{name}", {
      org,
      name,
    }),
  );
}

// ---------- pull requests ----------

export type GhPull = {
  number: number;
  state: string;
  draft?: boolean;
  merged?: boolean;
  mergeable: boolean | null;
  mergeable_state?: string;
  merge_commit_sha?: string | null;
  title?: string;
  head: { sha: string };
};

export async function getPull(
  api: GitHubApi,
  repo: Repo,
  number: number,
): Promise<GhPull> {
  const res = await api.request<GhPull>(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    { owner: repo.ownerLogin, repo: repo.name, pull_number: number },
  );
  return res.data;
}

const MAX_FILE_PAGES = 30; // GitHub lists at most 3,000 files.

/** Every changed file path of a PR (`GET /pulls/{n}/files`). */
export async function listPullFiles(
  api: GitHubApi,
  repo: Repo,
  number: number,
): Promise<string[]> {
  const out: string[] = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const res = await api.request<Array<{ filename: string }>>(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      {
        owner: repo.ownerLogin,
        repo: repo.name,
        pull_number: number,
        per_page: 100,
        page,
      },
    );
    out.push(...res.data.map((f) => f.filename));
    if (res.data.length < 100) break;
  }
  return out;
}

export type MergeMethod = "merge" | "squash" | "rebase";

export async function mergePull(
  api: GitHubApi,
  repo: Repo,
  number: number,
  input: { sha: string; method: MergeMethod; commitMessage?: string },
): Promise<Written & { sha: string | null }> {
  const res = await api.request<{ merged?: boolean; sha?: string }>(
    "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
    {
      owner: repo.ownerLogin,
      repo: repo.name,
      pull_number: number,
      sha: input.sha,
      merge_method: input.method,
      ...(input.commitMessage ? { commit_message: input.commitMessage } : {}),
    },
  );
  return { ...written(res), sha: res.data.sha ?? null };
}
