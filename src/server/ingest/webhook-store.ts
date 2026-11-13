import "server-only";
import { revalidateTag } from "next/cache";
import { after } from "next/server";
import { describeError } from "@/lib/describe-error";
import { Prisma } from "@/generated/prisma/client";
import { isAllowedAccount } from "@/server/authz/config";
import { db } from "@/server/db";
import {
  handleWorkflowJobEvent,
  handleWorkflowRunEvent,
} from "./actions-events";
import { verifyAndStoreInstallation } from "./discovery";
import {
  forgetForeignInstallation,
  isKnownForeignInstallation,
  namesForeignOwner,
  rememberForeignInstallation,
} from "./foreign-installations";
import {
  handleAppAuthorizationEvent,
  handleInstallationEvent,
  handleInstallationRepositoriesEvent,
  handleRepositoryEvent,
} from "./inventory";
import type { WorkflowJobPayload, WorkflowRunPayload } from "./github-map";
import type {
  AppAuthorizationEvent,
  InstallationEvent,
  InstallationRepositoriesEvent,
  RepositoryEvent,
} from "./types";
import { ignoredRepoCheck, type WebhookStore } from "./webhook";
import {
  foldDeploymentHint,
  refreshFromHint,
  type HintPayload,
} from "./vercel-hints";
import {
  foldCheckHint,
  refreshAzureBuilds,
  type CheckHintPayload,
} from "./azure-hints";

const LOCK_MS = 5 * 60 * 1000;

let signatureFailures = 0;

/** Signature failures since process start (shown on /admin/ops). */
export function signatureFailureCount(): number {
  return signatureFailures;
}

export const prismaWebhookStore: WebhookStore = {
  async insertDelivery(row) {
    const { count } = await db.webhookDelivery.createMany({
      data: [
        {
          ...row,
          payload: row.payload
            ? (row.payload as Prisma.InputJsonObject)
            : Prisma.DbNull,
        },
      ],
      skipDuplicates: true,
    });
    return count === 1 ? "inserted" : "duplicate";
  },

  async claimDelivery(id) {
    const now = new Date();
    const { count } = await db.webhookDelivery.updateMany({
      where: {
        id,
        status: { in: ["RECEIVED", "FAILED"] },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: {
        status: "PROCESSING",
        lockedUntil: new Date(now.getTime() + LOCK_MS),
      },
    });
    return count === 1;
  },

  async finishDelivery(id, outcome) {
    const now = new Date();
    switch (outcome.status) {
      case "PROCESSED":
        await db.webhookDelivery.update({
          where: { id },
          data: {
            status: "PROCESSED",
            payload: Prisma.DbNull,
            processedAt: now,
            lockedUntil: null,
            error: null,
          },
        });
        return;
      case "SKIPPED":
      case "REJECTED":
        await db.webhookDelivery.update({
          where: { id },
          data: {
            status: outcome.status,
            payload: Prisma.DbNull,
            processedAt: now,
            lockedUntil: null,
            error: outcome.reason,
          },
        });
        return;
      case "FAILED":
        await db.webhookDelivery.update({
          where: { id },
          data: {
            status: "FAILED",
            attempts: { increment: 1 },
            error: outcome.error,
            lockedUntil: null,
          },
        });
        return;
    }
  },

  async checkTenant(event, payload) {
    if (event === "github_app_authorization")
      return { ok: true, installationId: null };

    const inst = payload.installation;
    if (!inst?.id)
      return {
        ok: false,
        status: "SKIPPED",
        reason: "no installation in payload",
      };
    const installationId = BigInt(inst.id);

    // Installation events carry the full installation; they are what creates,
    // restores and deletes it locally.
    if (event === "installation" || event === "installation_repositories") {
      if (!isAllowedAccount(inst.account?.login)) {
        return {
          ok: false,
          status: "SKIPPED",
          reason: "account not in ALLOWED_ACCOUNTS",
        };
      }
      forgetForeignInstallation(installationId);
      return { ok: true, installationId };
    }

    let local = await db.installation.findUnique({
      where: { id: installationId },
    });
    if (!local) {
      // Unknown installation. Cheap checks first, so foreign accounts cannot
      // spend the App JWT rate limit (see foreign-installations.ts).
      if (
        isKnownForeignInstallation(installationId) ||
        namesForeignOwner(payload, isAllowedAccount)
      ) {
        return {
          ok: false,
          status: "SKIPPED",
          reason: "installation unknown or not allowed",
        };
      }
      // Then ask GitHub (App JWT) instead of trusting the payload.
      const login = await verifyAndStoreInstallation(installationId);
      if (!login) {
        rememberForeignInstallation(installationId);
        return {
          ok: false,
          status: "SKIPPED",
          reason: "installation unknown or not allowed",
        };
      }
      local = await db.installation.findUnique({
        where: { id: installationId },
      });
    }
    if (!local || !isAllowedAccount(local.accountLogin)) {
      return {
        ok: false,
        status: "SKIPPED",
        reason: "installation not allowed",
      };
    }
    if (local.deletedAt || local.suspendedAt) {
      return {
        ok: false,
        status: "SKIPPED",
        reason: "installation suspended or deleted",
      };
    }

    if (payload.repository?.id != null) {
      const repo = await db.repository.findUnique({
        where: { id: BigInt(payload.repository.id) },
        select: { installationId: true, ignoredAt: true },
      });
      if (repo && repo.installationId !== installationId) {
        console.warn(
          "security: webhook repository belongs to another installation",
          {
            event,
            installationId: String(installationId),
          },
        );
        return {
          ok: false,
          status: "REJECTED",
          reason: "repository belongs to another installation",
        };
      }
      const ignored = ignoredRepoCheck(event, repo?.ignoredAt != null);
      if (ignored) return ignored;
    }
    return { ok: true, installationId };
  },

  async fold(event, payload, installationId, receivedAt) {
    switch (event) {
      case "workflow_job":
        if (installationId !== null && payload.workflow_job) {
          await handleWorkflowJobEvent(
            installationId,
            payload as unknown as WorkflowJobPayload,
            receivedAt,
          );
        }
        return;
      case "workflow_run":
        if (installationId !== null && payload.workflow_run) {
          await handleWorkflowRunEvent(
            installationId,
            payload as unknown as WorkflowRunPayload,
            receivedAt,
          );
        }
        return;
      case "installation":
        await handleInstallationEvent(payload as unknown as InstallationEvent);
        return;
      case "installation_repositories":
        await handleInstallationRepositoriesEvent(
          payload as unknown as InstallationRepositoriesEvent,
        );
        return;
      case "repository":
        if (installationId !== null) {
          await handleRepositoryEvent(
            installationId,
            payload as unknown as RepositoryEvent,
          );
        }
        return;
      case "deployment_status":
        if (installationId !== null) {
          const ids = await foldDeploymentHint(
            installationId,
            payload as unknown as HintPayload,
            new Date(),
          );
          if (ids.length > 0) {
            try {
              after(() =>
                refreshFromHint(installationId, ids).catch((error: unknown) =>
                  console.warn(
                    "Vercel hint refresh failed",
                    describeError(error),
                  ),
                ),
              );
            } catch {
              // Outside a request (replays): the dirty mark is picked up by step v3.
            }
          }
        }
        return;
      case "check_run":
      case "check_suite":
        if (installationId !== null) {
          const hint = await foldCheckHint(
            installationId,
            event,
            payload as unknown as CheckHintPayload,
            new Date(),
          );
          if (hint && hint.builds.length > 0) {
            try {
              after(() =>
                refreshAzureBuilds(installationId, hint.builds).catch(
                  (error: unknown) =>
                    console.warn(
                      "Azure DevOps hint refresh failed",
                      describeError(error),
                    ),
                ),
              );
            } catch {
              // Outside a request (replays): the dirty marks are picked up by step z3.
            }
          }
        }
        return;
      case "github_app_authorization":
        await handleAppAuthorizationEvent(
          payload as unknown as AppAuthorizationEvent,
        );
        return;
    }
  },

  async touched(installationId) {
    await db.installation.updateMany({
      where: { id: installationId },
      data: { lastWebhookAt: new Date() },
    });
    revalidateTag(`inst:${installationId}`, "max");
  },

  onSignatureFailure() {
    signatureFailures++;
    console.warn("webhook signature verification failed");
  },
};
