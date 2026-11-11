import "server-only";
import { App } from "@octokit/app";
import { Octokit as OctokitCore } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { LRUCache } from "lru-cache";
import { env } from "@/env";
import {
  isMutationPurpose,
  permissionsFor,
  type TokenPurpose,
} from "./purposes";

/**
 * The only path to GitHub for sync, reads and mutations (design §3.4).
 *
 * - `appOctokit()` authenticates as the App (JWT). It is used for installation
 *   discovery, minting installation tokens and the hook delivery log.
 * - `installationOctokit(id, purpose, repoIds?)` is the token broker: it mints
 *   an installation token narrowed to the purpose's permission set (and repo
 *   ids, when known). Tokens live only in an in-memory LRU until five minutes
 *   before expiry; mutation tokens are never cached. Tokens are never written
 *   to the DB or to logs.
 * - Every request is bounded: reconcile passes a deadline-derived signal
 *   (ingest/github-client.ts `withDeadline`), everything else gets 30 s.
 */

/** Upper bound for any GitHub request that has no tighter signal of its own. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Gives every request without its own AbortSignal a timeout. */
function requestTimeout(octokit: OctokitCore) {
  octokit.hook.before("request", (options) => {
    options.request ??= {};
    options.request.signal ??= AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  });
}

export const Octokit = OctokitCore.plugin(
  paginateRest,
  requestTimeout,
).defaults({
  userAgent: "devops-manager",
});
export type Octokit = InstanceType<typeof Octokit>;

/** Accepts a PEM key, a PEM with literal `\n`, or base64 of the PEM. */
export function decodePrivateKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed.replace(/\\n/g, "\n");
  return Buffer.from(trimmed, "base64").toString("utf8");
}

let app: App<{ Octokit: typeof Octokit }> | undefined;

export function githubApp() {
  app ??= new App({
    appId: env.GITHUB_APP_ID,
    privateKey: decodePrivateKey(env.GITHUB_APP_PRIVATE_KEY),
    Octokit,
  });
  return app;
}

/** Octokit authenticated as the App itself (JWT). */
export function appOctokit(): Octokit {
  return githubApp().octokit;
}

type CachedToken = { token: string; expiresAt: number };

const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

const tokenCache = new LRUCache<string, CachedToken>({
  max: 500,
  ttlAutopurge: false,
});

export type GrantedPermissions = Record<string, unknown>;

/**
 * Installation-scoped Octokit for one purpose. `granted` is the installation's
 * `permissions` as stored; it decides which optional permissions are asked for.
 */
export async function installationOctokit(
  installationId: bigint | number | string,
  purpose: TokenPurpose,
  granted: GrantedPermissions,
  repoIds?: ReadonlyArray<bigint | number>,
): Promise<Octokit> {
  const permissions = permissionsFor(purpose, granted);
  const repositoryIds = repoIds?.map((id) => Number(id)).sort((a, b) => a - b);
  if (repositoryIds && repositoryIds.length > 500) {
    throw new Error("A token can be narrowed to at most 500 repositories");
  }
  if (
    isMutationPurpose(purpose) &&
    (!repositoryIds || repositoryIds.length === 0)
  ) {
    // Repo-level mutation tokens are always narrowed to their targets.
    if (purpose !== "act.org_variables") {
      throw new Error(
        `Mutation token ${purpose} needs the target repository ids`,
      );
    }
  }

  const key = `${installationId}|${purpose}|${repositoryIds?.join(",") ?? "*"}`;
  const cacheable = !isMutationPurpose(purpose);
  const cached = cacheable ? tokenCache.get(key) : undefined;
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return new Octokit({ auth: cached.token });
  }

  const { data } = await appOctokit().request(
    "POST /app/installations/{installation_id}/access_tokens",
    {
      installation_id: Number(installationId),
      permissions,
      ...(repositoryIds ? { repository_ids: repositoryIds } : {}),
    },
  );
  if (cacheable) {
    tokenCache.set(key, {
      token: data.token,
      expiresAt: Date.parse(data.expires_at),
    });
  }
  return new Octokit({ auth: data.token });
}

/** Drops cached tokens of an installation (uninstall, permission change). */
export function forgetInstallationTokens(
  installationId: bigint | number | string,
) {
  const prefix = `${installationId}|`;
  for (const key of tokenCache.keys())
    if (key.startsWith(prefix)) tokenCache.delete(key);
}

export function installUrl(): string {
  return `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`;
}

export function actingAs(): string {
  return `app:${env.GITHUB_APP_SLUG}[bot]`;
}
