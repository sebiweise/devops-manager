import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import type { Deadline } from "./budget";
import { errorStatus, pages, type GitHubApi } from "./github-client";
import type { WebhookPayload } from "./types";
import { processDelivery } from "./webhook";
import { prismaWebhookStore } from "./webhook-store";

/**
 * Reconcile steps a) and b) (design §5.3): replay local failures and repair
 * deliveries GitHub could not hand over (for example a 503 while the database
 * was unreachable).
 */

export const MAX_ATTEMPTS = 8;
const RECEIVED_GRACE_MS = 2 * 60 * 1000;
const REPLAY_BATCH = 50;
const HOOK_LOG_WINDOW_MS = 72 * 60 * 60 * 1000;
const MAX_REDELIVERIES = 50;
const HOOK_CURSOR_KEY = "hookDeliveries";

export type ReplayResult = { replayed: number; dead: number };

/**
 * a) Re-processes RECEIVED deliveries older than two minutes, FAILED ones
 * with fewer than eight attempts, and PROCESSING ones whose lock expired.
 * After eight failed attempts a delivery becomes DEAD (listed for manual
 * replay). `installationId` limits the replay to one installation.
 */
export async function replayDeliveries(
  deadline: Deadline,
  installationId?: bigint,
): Promise<ReplayResult> {
  const now = new Date(deadline.now());
  const scope = installationId !== undefined ? { installationId } : {};

  // A worker that died mid-fold leaves PROCESSING behind; make it replayable.
  await db.webhookDelivery.updateMany({
    where: { ...scope, status: "PROCESSING", lockedUntil: { lt: now } },
    data: { status: "FAILED", lockedUntil: null, attempts: { increment: 1 } },
  });
  const dead = await db.webhookDelivery.updateMany({
    where: { ...scope, status: "FAILED", attempts: { gte: MAX_ATTEMPTS } },
    data: { status: "DEAD" },
  });

  const rows = await db.webhookDelivery.findMany({
    where: {
      ...scope,
      payload: { not: Prisma.DbNull },
      OR: [
        {
          status: "RECEIVED",
          receivedAt: { lt: new Date(now.getTime() - RECEIVED_GRACE_MS) },
        },
        { status: "FAILED", attempts: { lt: MAX_ATTEMPTS } },
      ],
    },
    orderBy: { receivedAt: "asc" },
    take: REPLAY_BATCH,
    select: { id: true, event: true, payload: true, receivedAt: true },
  });

  let replayed = 0;
  for (const row of rows) {
    if (deadline.expired()) break;
    await processDelivery(prismaWebhookStore, {
      id: row.id,
      event: row.event,
      payload: row.payload as unknown as WebhookPayload,
      receivedAt: row.receivedAt,
    });
    replayed++;
  }
  return { replayed, dead: dead.count };
}

type HookDelivery = {
  id: number;
  guid: string;
  delivered_at: string;
  redelivery?: boolean;
  status?: string;
  status_code: number;
  event?: string;
  action?: string | null;
  installation_id?: number | null;
  repository_id?: number | null;
};

export type HookLogResult = {
  scanned: number;
  redelivered: number;
  resync: number;
  complete: boolean;
};

const isOk = (code: number) => code >= 200 && code < 300;

/**
 * b) Walks GitHub's delivery log (`GET /app/hook/deliveries`, App JWT) newest
 * first, back to the stored cursor or 72 hours. For every GUID that never got
 * a 2xx and is unknown locally:
 * - an oversized delivery (413) is not redelivered: the repository (or every
 *   repository of the installation) is marked `needsResync` instead;
 * - anything else is redelivered, at most 50 per tick.
 * The cursor only advances after a complete walk.
 */
export async function repairHookDeliveries(
  app: GitHubApi,
  deadline: Deadline,
): Promise<HookLogResult> {
  const now = deadline.now();
  const state = await db.appState.findUnique({
    where: { key: HOOK_CURSOR_KEY },
  });
  const lastId = Number((state?.value as { lastId?: number })?.lastId ?? 0);
  const result: HookLogResult = {
    scanned: 0,
    redelivered: 0,
    resync: 0,
    complete: false,
  };

  const byGuid = new Map<string, { ok: boolean; latest: HookDelivery }>();
  let newest = lastId;
  let reachedEnd = false;
  try {
    outer: for await (const page of pages<HookDelivery[]>(
      app,
      "GET /app/hook/deliveries",
      { per_page: 100 },
    )) {
      for (const d of page.data) {
        if (
          d.id <= lastId ||
          Date.parse(d.delivered_at) < now - HOOK_LOG_WINDOW_MS
        ) {
          reachedEnd = true;
          break outer;
        }
        result.scanned++;
        newest = Math.max(newest, d.id);
        const entry = byGuid.get(d.guid);
        if (!entry) byGuid.set(d.guid, { ok: isOk(d.status_code), latest: d });
        else {
          entry.ok ||= isOk(d.status_code);
          if (d.id > entry.latest.id) entry.latest = d;
        }
      }
      if (deadline.expired()) break;
    }
    if (!deadline.expired()) reachedEnd = true;
  } catch (error) {
    // The delivery log is best effort (polling-only mode has no webhook).
    if (errorStatus(error) === 404) return { ...result, complete: true };
    throw error;
  }

  const failed = [...byGuid.entries()].filter(([, e]) => !e.ok);
  const known = new Set(
    (
      await db.webhookDelivery.findMany({
        where: { id: { in: failed.map(([guid]) => guid) } },
        select: { id: true },
      })
    ).map((r) => r.id),
  );

  let capped = false;
  for (const [guid, { latest }] of failed) {
    // A known GUID has its payload stored; step a) replays it locally.
    if (known.has(guid)) continue;
    if (latest.status_code === 413) {
      result.resync += await markResync(
        latest.installation_id,
        latest.repository_id,
      );
      continue;
    }
    if (result.redelivered >= MAX_REDELIVERIES || deadline.expired()) {
      capped = true;
      break;
    }
    try {
      await app.request("POST /app/hook/deliveries/{delivery_id}/attempts", {
        delivery_id: latest.id,
      });
      result.redelivered++;
    } catch (error) {
      console.warn("redelivery failed", { status: errorStatus(error) });
    }
  }

  result.complete = reachedEnd && !capped;
  if (result.complete && newest > lastId) {
    await db.appState.upsert({
      where: { key: HOOK_CURSOR_KEY },
      create: { key: HOOK_CURSOR_KEY, value: { lastId: newest } },
      update: { value: { lastId: newest } },
    });
  }
  return result;
}

async function markResync(
  installationId: number | null | undefined,
  repositoryId: number | null | undefined,
): Promise<number> {
  if (repositoryId != null) {
    const { count } = await db.syncState.updateMany({
      where: {
        repositoryId: BigInt(repositoryId),
        ...(installationId != null
          ? { installationId: BigInt(installationId) }
          : {}),
      },
      data: { needsResync: true },
    });
    if (count > 0) return count;
  }
  if (installationId == null) return 0;
  const { count } = await db.syncState.updateMany({
    where: { installationId: BigInt(installationId) },
    data: { needsResync: true },
  });
  return count;
}
