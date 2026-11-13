import { createHash } from "node:crypto";
import { z } from "zod";
import type { Fetch } from "./client";

/**
 * Microsoft Entra service principal tokens (design addendum M7c): the
 * client credentials grant against the tenant's v2 token endpoint, for the
 * Azure DevOps resource `499b84ac-1321-427f-aa17-267ca6975798` (scope
 * `<resource>/.default`). Only a client secret is supported; certificates
 * and federation are out of scope.
 *
 * - The host is pinned to `login.microsoftonline.com`; it is used only for
 *   connections of kind ENTRA_SP.
 * - Tokens are cached in memory per (tenant, client, secret hash) until
 *   5 minutes before they expire; never persisted, never logged.
 * - A rejected secret (`invalid_client`, AADSTS7000215, unauthorized client,
 *   unknown tenant) is `EntraError.revoked`: the connection is marked
 *   revoked like a PAT that answers 401.
 */

export const ENTRA_ORIGIN = "https://login.microsoftonline.com";
/** The Azure DevOps resource (application) id. */
export const AZURE_DEVOPS_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
export const AZURE_DEVOPS_SCOPE = `${AZURE_DEVOPS_RESOURCE}/.default`;
const EXPIRY_MARGIN_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value: string): boolean {
  return GUID.test(value);
}

export type EntraCredential = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

export class EntraError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string,
    message: string,
    /** The secret, client or tenant was rejected. */
    readonly revoked: boolean,
  ) {
    super(message);
    this.name = "EntraError";
  }
}

const tokenSchema = z.object({
  access_token: z.string().min(10).max(16_000),
  expires_in: z.union([z.number(), z.string()]).nullish(),
  token_type: z.string().nullish(),
});

const errorSchema = z.object({
  error: z.string().max(100).nullish(),
  error_codes: z.array(z.number()).max(20).nullish(),
});

const REVOKED_ERRORS = new Set([
  "invalid_client",
  "unauthorized_client",
  "invalid_request",
  "invalid_tenant",
]);

type Cached = { token: string; expiresAt: number };
const cache = new Map<string, Cached>();

function cacheKey(c: EntraCredential): string {
  return createHash("sha256")
    .update(
      `${c.tenantId.toLowerCase()}\0${c.clientId.toLowerCase()}\0${c.clientSecret}`,
    )
    .digest("hex");
}

/** The token endpoint of a tenant (GUID only). */
export function tokenUrl(tenantId: string): string {
  if (!GUID.test(tenantId)) throw new Error("tenant id must be a GUID");
  const url = new URL(
    `${ENTRA_ORIGIN}/${encodeURIComponent(tenantId.toLowerCase())}/oauth2/v2.0/token`,
  );
  if (url.origin !== ENTRA_ORIGIN)
    throw new Error("login.microsoftonline.com only");
  return url.toString();
}

/** An access token for Azure DevOps (cached). */
export async function entraToken(
  c: EntraCredential,
  opts: { fetch?: Fetch; now?: () => number; noCache?: boolean } = {},
): Promise<{ token: string; expiresAt: Date }> {
  if (!GUID.test(c.clientId))
    throw new EntraError(
      null,
      "invalid_client_id",
      "client id must be a GUID",
      true,
    );
  const now = opts.now ?? Date.now;
  const key = cacheKey(c);
  const hit = opts.noCache ? undefined : cache.get(key);
  if (hit && hit.expiresAt - EXPIRY_MARGIN_MS > now())
    return { token: hit.token, expiresAt: new Date(hit.expiresAt) };
  const doFetch: Fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(tokenUrl(c.tenantId), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: c.clientId,
        client_secret: c.clientSecret,
        scope: AZURE_DEVOPS_SCOPE,
      }).toString(),
      signal,
      redirect: "manual",
      cache: "no-store",
    });
  } catch (error) {
    throw new EntraError(
      null,
      signal.aborted ? "timeout" : "network",
      error instanceof Error ? error.message : "network error",
      false,
    );
  }
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = errorSchema.safeParse(body);
    const code = (err.success && err.data.error) || `http_${res.status}`;
    const revoked =
      res.status === 401 ||
      (res.status === 400 && REVOKED_ERRORS.has(code)) ||
      (err.success &&
        (err.data.error_codes ?? []).some(
          (n) => n === 7000215 || n === 700016 || n === 90002,
        ));
    cache.delete(key);
    // Entra's error_description may echo ids; only the code is kept.
    throw new EntraError(
      res.status,
      code,
      `Microsoft Entra refused the token request (${code})`,
      revoked,
    );
  }
  const parsed = tokenSchema.safeParse(body);
  if (!parsed.success)
    throw new EntraError(
      res.status,
      "unexpected_response",
      "Unexpected response from Microsoft Entra",
      false,
    );
  const seconds = Number(parsed.data.expires_in ?? 3600);
  const expiresAt =
    now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
  if (!opts.noCache)
    cache.set(key, { token: parsed.data.access_token, expiresAt });
  return { token: parsed.data.access_token, expiresAt: new Date(expiresAt) };
}

/** Tests only. */
export function clearEntraCache(): void {
  cache.clear();
}
