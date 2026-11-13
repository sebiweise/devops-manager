"use server";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import { actorProviderOf, appendAudit } from "@/server/audit/log";
import { hasRole } from "@/server/authz/roles";
import { requireScope } from "@/server/better-auth/session";
import { inScope } from "@/server/data/installations";
import {
  claimSyncNow,
  scheduleInstallationReconcile,
} from "@/server/ingest/triggers";

/**
 * Sync now (design §8.2 #11): an operator or admin runs reconcile for one
 * installation. Limited to once per five minutes per installation and
 * audited (SYNC_NOW). A foreign or unknown installation answers 404; a viewer
 * gets a DENIED audit row and "forbidden".
 */

const input = z.object({
  installationId: z.string().regex(/^\d{1,20}$/),
  idempotencyKey: z.uuid().optional(),
});

export type SyncNowResult = {
  status: "started" | "rate_limited" | "forbidden";
};

export async function syncNow(raw: {
  installationId: string;
  idempotencyKey?: string;
}): Promise<SyncNowResult> {
  const { user, scope } = await requireScope();
  const parsed = input.safeParse(raw);
  if (!parsed.success) notFound();
  const installationId = BigInt(parsed.data.installationId);
  if (!inScope(scope, installationId)) notFound();

  const audit = {
    installationId,
    actorUserId: user.id,
    actorDisplay: user.name || user.email,
    actorRole: scope.role,
    actorProvider: await actorProviderOf(user.id),
    actingAs: null,
    action: "SYNC_NOW" as const,
    targetType: "installation",
    targetId: String(installationId),
    params: {},
    confirmation: "NONE" as const,
    idempotencyKey: parsed.data.idempotencyKey ?? randomUUID(),
  };

  if (!hasRole(scope.role, "OPERATOR")) {
    await appendAudit({ ...audit, status: "DENIED" });
    return { status: "forbidden" };
  }
  if (!(await claimSyncNow(installationId))) return { status: "rate_limited" };

  await appendAudit({ ...audit, status: "SUCCEEDED" });
  scheduleInstallationReconcile(
    installationId,
    (task) => after(task),
    undefined,
    { forceVercelProjects: true },
  );
  return { status: "started" };
}
