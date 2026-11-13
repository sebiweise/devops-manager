import "server-only";
import { after } from "next/server";
import { describeError } from "@/lib/describe-error";
import { db } from "@/server/db";
import { decryptAzureSecret } from "./azure-credential";
import { refreshAzureBuilds } from "./azure-hints";
import {
  HOOK_BLOCK_MS,
  HOOK_FAILURE_LIMIT,
  HOOK_FAILURE_WINDOW_MS,
  type AzureHookStore,
} from "./azure-hook";

/** The database side of the Azure DevOps service hook route. */
export const prismaAzureHookStore: AzureHookStore = {
  async findConnection(hookKey) {
    const c = await db.azureDevOpsConnection.findUnique({
      where: { hookKey },
      select: {
        installationId: true,
        orgId: true,
        hookSecret: true,
        hookSecretPrev: true,
        hookSecretPrevUntil: true,
        hookBlockedUntil: true,
        revokedAt: true,
        installation: { select: { deletedAt: true, suspendedAt: true } },
      },
    });
    if (!c || c.installation.deletedAt || c.installation.suspendedAt)
      return null;
    const plain = (
      column: "hookSecret" | "hookSecretPrev",
      v: string | null,
    ) => {
      if (!v) return null;
      try {
        return decryptAzureSecret(c.installationId, column, v);
      } catch {
        return null;
      }
    };
    return {
      installationId: c.installationId,
      orgId: c.orgId,
      secret: plain("hookSecret", c.hookSecret),
      previousSecret: plain("hookSecretPrev", c.hookSecretPrev),
      previousUntil: c.hookSecretPrevUntil,
      blockedUntil: c.hookBlockedUntil,
    };
  },

  async recordFailure(installationId, now) {
    const windowStart = new Date(now.getTime() - HOOK_FAILURE_WINDOW_MS);
    // Restart the window when the last one is over, then count.
    await db.azureDevOpsConnection.updateMany({
      where: {
        installationId,
        OR: [
          { hookFailuresSince: null },
          { hookFailuresSince: { lt: windowStart } },
        ],
      },
      data: { hookFailures: 0, hookFailuresSince: now },
    });
    const c = await db.azureDevOpsConnection.update({
      where: { installationId },
      data: { hookFailures: { increment: 1 } },
      select: { hookFailures: true },
    });
    if (c.hookFailures > HOOK_FAILURE_LIMIT)
      await db.azureDevOpsConnection.updateMany({
        where: { installationId },
        data: {
          hookBlockedUntil: new Date(now.getTime() + HOOK_BLOCK_MS),
          hookFailures: 0,
          hookFailuresSince: null,
        },
      });
    console.warn(
      "Azure DevOps hook authentication failed",
      String(installationId),
    );
  },

  async isSelectedProject(installationId, projectId) {
    const p = await db.azureDevOpsProject.findFirst({
      where: { installationId, id: projectId, selected: true, removedAt: null },
      select: { id: true },
    });
    return !!p;
  },

  async insertDelivery(row) {
    const { count } = await db.webhookDelivery.createMany({
      data: [
        {
          id: row.id,
          provider: "azure",
          event: row.event.slice(0, 100),
          installationId: row.installationId,
          payloadBytes: row.payloadBytes,
          status: "PROCESSED",
          processedAt: new Date(),
        },
      ],
      skipDuplicates: true,
    });
    return count === 1 ? "inserted" : "duplicate";
  },

  async markDirty(installationId, projectId, buildId) {
    const now = new Date();
    if (buildId != null)
      await db.azureBuild.updateMany({
        where: { installationId, id: buildId },
        data: { dirtyAt: now },
      });
    await db.azurePipelineDefinition.updateMany({
      where: { installationId, projectId, removedAt: null },
      data: { dirtyAt: now },
    });
    if (buildId == null) return;
    try {
      after(() =>
        refreshAzureBuilds(installationId, [{ projectId, buildId }]).catch(
          (error: unknown) =>
            console.warn(
              "Azure DevOps hook refresh failed",
              describeError(error),
            ),
        ),
      );
    } catch {
      // Outside a request: the dirty mark is picked up by step z3.
    }
  },

  security(message, details) {
    console.warn(message, details);
  },
};
