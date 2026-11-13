import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Azure DevOps service hook deliveries (design addendum M7 §4.5),
 * independent of Next and Prisma so every branch is unit-tested; the route
 * (src/app/api/azure/hooks/[hookKey]/route.ts) wires it to the database
 * through `AzureHookStore`.
 *
 * Validation order:
 * 1. Body ≤ 256 KB (the route also stops reading past it).
 * 2. The route key names a connection; a key blocked after more than 10
 *    failures in 5 minutes answers 429 for 15 minutes.
 * 3. Basic auth: user = the route key, password = the hook secret,
 *    compared in constant time on HMAC digests, against the current secret
 *    and then the previous one within 7 days of a rotation.
 * 4. zod envelope, 5. event allowlist, 6. the account (or collection) id
 *    must equal the connection's organisation id (else 403 and a security
 *    log line), 7. the project must be selected, 8. dedupe on
 *    (azure, notificationId).
 *
 * Effect: the named build is marked dirty and a targeted refresh is
 * scheduled; the answer is 200 within the request. The payload is never
 * used as state and never stored.
 */

export const HOOK_MAX_BYTES = 256 * 1024;
export const HOOK_FAILURE_LIMIT = 10;
export const HOOK_FAILURE_WINDOW_MS = 5 * 60_000;
export const HOOK_BLOCK_MS = 15 * 60_000;
export const HOOK_PREVIOUS_SECRET_MS = 7 * 86_400_000;

export const HOOK_EVENTS = new Set([
  "ms.vss-pipelines.run-state-changed-event",
  "ms.vss-pipelines.job-state-changed-event",
  "build.complete",
]);

const HOOK_KEY = /^[A-Za-z0-9_-]{16,64}$/;

/** A random 128-bit route key and a 256-bit secret. */
export function newHookCredentials(): { hookKey: string; secret: string } {
  return {
    hookKey: randomBytes(16).toString("base64url"),
    secret: randomBytes(32).toString("base64url"),
  };
}

const digestKey = randomBytes(32);

/** Constant-time comparison of two secrets (HMAC digests of equal length). */
export function secretMatches(provided: string, expected: string): boolean {
  const a = createHmac("sha256", digestKey).update(provided, "utf8").digest();
  const b = createHmac("sha256", digestKey).update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** User and password of a Basic Authorization header. */
export function parseBasic(
  header: string | null,
): { user: string; password: string } | null {
  if (!header) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=]{4,1024})$/i.exec(header.trim());
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  return { user: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

const guid = z.string().regex(/^[0-9a-f-]{36}$/i);

export const hookEnvelopeSchema = z.object({
  id: z.string().max(100).nullish(),
  notificationId: z.union([z.number(), z.string().max(100)]).nullish(),
  subscriptionId: z.string().max(100).nullish(),
  eventType: z.string().max(200),
  resourceContainers: z
    .object({
      account: z.object({ id: guid }).nullish(),
      collection: z.object({ id: guid }).nullish(),
      project: z.object({ id: guid }).nullish(),
    })
    .nullish(),
  resource: z
    .object({
      id: z.union([z.number(), z.string().max(100)]).nullish(),
      run: z.object({ id: z.number().int().nullish() }).nullish(),
      project: z.object({ id: guid.nullish() }).nullish(),
    })
    .nullish(),
});

export type HookConnection = {
  installationId: bigint;
  orgId: string;
  /** Plain secrets (decrypted by the store). */
  secret: string | null;
  previousSecret: string | null;
  previousUntil: Date | null;
  blockedUntil: Date | null;
};

export interface AzureHookStore {
  findConnection(hookKey: string): Promise<HookConnection | null>;
  /** Counts a failure; blocks the key past the limit. */
  recordFailure(installationId: bigint, now: Date): Promise<void>;
  isSelectedProject(
    installationId: bigint,
    projectId: string,
  ): Promise<boolean>;
  /** INSERT … ON CONFLICT DO NOTHING of WebhookDelivery (provider azure). */
  insertDelivery(row: {
    id: string;
    installationId: bigint;
    event: string;
    payloadBytes: number;
  }): Promise<"inserted" | "duplicate">;
  /** Marks the build dirty and schedules the targeted refresh. */
  markDirty(
    installationId: bigint,
    projectId: string,
    buildId: number | null,
  ): Promise<void>;
  security(message: string, details: Record<string, string>): void;
}

export type HookRequest = {
  hookKey: string;
  authorization: string | null;
  body: string | Uint8Array;
};

export type HookResponse = { status: number; body: Record<string, unknown> };

const json = (status: number, body: Record<string, unknown>): HookResponse => ({
  status,
  body,
});

export async function handleAzureHook(
  req: HookRequest,
  store: AzureHookStore,
  deps: { now?: () => Date; compare?: (a: string, b: string) => boolean } = {},
): Promise<HookResponse> {
  const now = deps.now?.() ?? new Date();
  const compare = deps.compare ?? secretMatches;
  const raw =
    typeof req.body === "string"
      ? Buffer.from(req.body, "utf8")
      : Buffer.from(req.body);
  if (raw.byteLength > HOOK_MAX_BYTES)
    return json(413, { error: "payload too large" });
  if (!HOOK_KEY.test(req.hookKey)) return json(404, { error: "not found" });
  const conn = await store.findConnection(req.hookKey);
  if (!conn) return json(404, { error: "not found" });
  if (conn.blockedUntil && conn.blockedUntil > now)
    return json(429, { error: "too many failed attempts" });

  const basic = parseBasic(req.authorization);
  const userOk = basic ? compare(basic.user, req.hookKey) : false;
  const current =
    basic && conn.secret ? compare(basic.password, conn.secret) : false;
  const previous =
    basic &&
    conn.previousSecret &&
    conn.previousUntil &&
    conn.previousUntil > now
      ? compare(basic.password, conn.previousSecret)
      : false;
  if (!basic || !userOk || !(current || previous)) {
    await store.recordFailure(conn.installationId, now);
    return json(401, { error: "unauthorized" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  const parsed = hookEnvelopeSchema.safeParse(payload);
  if (!parsed.success) return json(400, { error: "invalid envelope" });
  const env = parsed.data;
  if (!HOOK_EVENTS.has(env.eventType))
    return json(202, { result: "ignored event" });
  // The envelope carries both an account id and a collection id, which are
  // different GUIDs; the stored org id (connectionData instanceId) may be
  // either one (open M7.0 probe), so a match on either is accepted.
  const orgId = conn.orgId.toLowerCase();
  const containers = [
    env.resourceContainers?.account?.id,
    env.resourceContainers?.collection?.id,
  ].map((id) => (id ?? "").toLowerCase());
  if (!orgId || !containers.includes(orgId)) {
    store.security("security: Azure DevOps hook for another organisation", {
      installationId: String(conn.installationId),
    });
    return json(403, { error: "forbidden" });
  }
  const projectId = (
    env.resourceContainers?.project?.id ??
    env.resource?.project?.id ??
    ""
  ).toLowerCase();
  if (
    !projectId ||
    !(await store.isSelectedProject(conn.installationId, projectId))
  )
    return json(202, { result: "project not selected" });
  const deliveryId =
    env.notificationId != null ? String(env.notificationId) : env.id;
  if (!deliveryId) return json(400, { error: "missing notification id" });
  const inserted = await store.insertDelivery({
    id: `azure:${conn.installationId}:${deliveryId}`.slice(0, 200),
    installationId: conn.installationId,
    event: env.eventType,
    payloadBytes: raw.byteLength,
  });
  if (inserted === "duplicate") return json(200, { result: "duplicate" });
  const rawId =
    env.resource?.run?.id ??
    (env.eventType === "build.complete" ? env.resource?.id : null) ??
    null;
  const buildId =
    rawId != null && /^\d{1,10}$/.test(String(rawId)) ? Number(rawId) : null;
  await store.markDirty(conn.installationId, projectId, buildId);
  return json(200, { result: "accepted" });
}
