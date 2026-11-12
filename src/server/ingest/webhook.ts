import { verifySignature } from "./verify";
import type { WebhookPayload } from "./types";

/**
 * Webhook processing (design §5.1), independent of Next and Prisma so every
 * branch is unit-tested. The route wires it to the database through
 * `WebhookStore` (webhook-store.ts).
 */

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Events this App subscribes to or receives automatically (design §3.3). */
export const HANDLED_EVENTS = new Set([
  "workflow_run",
  "workflow_job",
  "repository",
  "installation",
  "installation_repositories",
  "github_app_authorization",
]);

/**
 * Events that carry repository data (runs, jobs, pull requests, alerts).
 * For an ignored repository they are recorded as SKIPPED (`repo_ignored`)
 * and not folded. Inventory events (`repository`, `installation_repositories`)
 * are still processed, so name, archive and fork changes stay current.
 */
export const REPO_DATA_EVENTS = new Set([
  "workflow_run",
  "workflow_job",
  "pull_request",
  "pull_request_review",
  "dependabot_alert",
]);

export const REPO_IGNORED_REASON = "repo_ignored";

/** The tenant-check result for a delivery about an ignored repository, or null. */
export function ignoredRepoCheck(
  event: string,
  repoIgnored: boolean,
): TenantCheck | null {
  if (!repoIgnored || !REPO_DATA_EVENTS.has(event)) return null;
  return { ok: false, status: "SKIPPED", reason: REPO_IGNORED_REASON };
}

export type DeliveryRow = {
  id: string;
  event: string;
  action: string | null;
  installationId: bigint | null;
  repositoryId: bigint | null;
  payloadBytes: number;
  payload: WebhookPayload | null;
  status: "RECEIVED" | "SKIPPED";
  /** Also the event time of the fold, so a replay folds like the original. */
  receivedAt: Date;
};

export type DeliveryOutcome =
  | { status: "PROCESSED" }
  | { status: "SKIPPED"; reason: string }
  | { status: "REJECTED"; reason: string }
  | { status: "FAILED"; error: string };

export type TenantCheck =
  | { ok: true; installationId: bigint | null }
  | { ok: false; status: "SKIPPED" | "REJECTED"; reason: string };

export interface WebhookStore {
  /** INSERT ... ON CONFLICT (id) DO NOTHING. Throws when the DB is unreachable. */
  insertDelivery(row: DeliveryRow): Promise<"inserted" | "duplicate">;
  /** Claims a RECEIVED/FAILED row for processing (status PROCESSING, 5 min lock). */
  claimDelivery(id: string): Promise<boolean>;
  /** Final status. PROCESSED, SKIPPED and REJECTED null the payload; FAILED keeps it. */
  finishDelivery(id: string, outcome: DeliveryOutcome): Promise<void>;
  /** Installation and repository consistency (design §5.1 step 6). */
  checkTenant(event: string, payload: WebhookPayload): Promise<TenantCheck>;
  /**
   * Applies the event (fold functions). `receivedAt` is the event time the
   * fold uses (the original delivery time for replays).
   */
  fold(
    event: string,
    payload: WebhookPayload,
    installationId: bigint | null,
    receivedAt: Date,
  ): Promise<void>;
  /** Cache invalidation and `lastWebhookAt`. */
  touched(installationId: bigint): Promise<void>;
  onSignatureFailure(): void;
}

export type WebhookRequest = {
  headers: Headers;
  /** The raw body. Bytes from `readBodyCapped`; strings in tests. */
  body: string | Uint8Array;
};

/**
 * Reads a request body as raw bytes, stopping as soon as it passes `max`.
 * Returns null when the body is larger, without buffering the rest, so a
 * chunked upload or a wrong Content-Length cannot make the server hold an
 * unbounded body before the signature is checked.
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number = MAX_BODY_BYTES,
): Promise<Buffer | null> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export type WebhookResponse = { status: number; body: Record<string, unknown> };

const json = (
  status: number,
  body: Record<string, unknown>,
): WebhookResponse => ({ status, body });

/** Removes token-like strings and truncates, for error columns. */
export function redactError(message: string, max = 500): string {
  return message
    .replace(
      /\b(gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g,
      "[redacted]",
    )
    .replace(
      /(authorization|bearer|token)(["'\s:=]+)(?:(?:bearer|token)\s+)?[^\s"',]+/gi,
      "$1$2[redacted]",
    )
    .slice(0, max);
}

export async function handleWebhook(
  req: WebhookRequest,
  secrets: ReadonlyArray<string | undefined>,
  store: WebhookStore,
): Promise<WebhookResponse> {
  // 1. Size cap. Reconcile recovers oversized deliveries through a resync.
  const declared = Number(req.headers.get("content-length") ?? "0");
  const raw =
    typeof req.body === "string" ? Buffer.from(req.body, "utf8") : req.body;
  if (declared > MAX_BODY_BYTES || raw.byteLength > MAX_BODY_BYTES) {
    return json(413, { error: "payload too large" });
  }

  // 2. Required headers.
  const event = req.headers.get("x-github-event");
  const deliveryId = req.headers.get("x-github-delivery");
  const signature = req.headers.get("x-hub-signature-256");
  if (!event || !deliveryId || !signature)
    return json(401, { error: "missing headers" });

  // 3. Signature. On failure nothing is persisted.
  if (!verifySignature(raw, signature, secrets)) {
    store.onSignatureFailure();
    return json(401, { error: "invalid signature" });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    ) as WebhookPayload;
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  const installationId =
    payload.installation?.id != null ? BigInt(payload.installation.id) : null;
  const repositoryId =
    payload.repository?.id != null ? BigInt(payload.repository.id) : null;
  const handled = HANDLED_EVENTS.has(event);

  // 4 + 5. Record the delivery (unknown events without payload) and dedupe.
  const receivedAt = new Date();
  const row: DeliveryRow = {
    id: deliveryId,
    event,
    action: typeof payload.action === "string" ? payload.action : null,
    installationId,
    repositoryId,
    payloadBytes: raw.byteLength,
    payload: handled ? payload : null,
    status: handled ? "RECEIVED" : "SKIPPED",
    receivedAt,
  };
  let inserted: "inserted" | "duplicate";
  try {
    inserted = await store.insertDelivery(row);
  } catch {
    // DB unreachable (e.g. a cold start beyond the pool timeout). GitHub
    // records the failure and reconcile redelivers it.
    return json(503, { error: "database unavailable" });
  }
  if (inserted === "duplicate") return json(200, { result: "duplicate" });
  if (!handled) return json(202, { result: "skipped" });

  const result = await processDelivery(store, {
    id: deliveryId,
    event,
    payload,
    receivedAt,
  });
  return json(202, { result });
}

export type StoredDelivery = {
  id: string;
  event: string;
  payload: WebhookPayload;
  receivedAt: Date;
};

/**
 * Steps 6-10 of §5.1 for a recorded delivery: tenant check, claim, fold and
 * finish. Used inline by the webhook route and by reconcile's replay of
 * RECEIVED and FAILED deliveries (step a). Returns a short result label.
 */
export async function processDelivery(
  store: WebhookStore,
  delivery: StoredDelivery,
): Promise<string> {
  const { id, event, payload } = delivery;
  try {
    // 6. Tenant check.
    const tenant = await store.checkTenant(event, payload);
    if (!tenant.ok) {
      await store.finishDelivery(id, {
        status: tenant.status,
        reason: tenant.reason,
      });
      return tenant.status.toLowerCase();
    }

    // 7. Claim the row.
    if (!(await store.claimDelivery(id))) return "in progress";

    // 8 + 9. Fold and finish.
    try {
      await store.fold(
        event,
        payload,
        tenant.installationId,
        delivery.receivedAt,
      );
    } catch (error) {
      // 10. The row is durable; reconcile replays it.
      await store.finishDelivery(id, {
        status: "FAILED",
        error: redactError(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return "failed";
    }
    await store.finishDelivery(id, { status: "PROCESSED" });
    if (tenant.installationId !== null)
      await store.touched(tenant.installationId);
    return "processed";
  } catch (error) {
    // Failures after the insert: the row stays RECEIVED or PROCESSING and is
    // replayed by reconcile, so GitHub does not need to redeliver.
    console.error("webhook processing failed", redactError(String(error)));
    return "queued for replay";
  }
}
