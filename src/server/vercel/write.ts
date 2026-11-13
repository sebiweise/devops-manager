import { z } from "zod";
import {
  deploymentSchema,
  mapDeployment,
  VercelError,
  vercelRequest,
  type VercelClientOptions,
  type VercelDeploymentInfo,
} from "./client";

/**
 * The Vercel write client (design addendum §6, §8.2, M6). Exactly four
 * mutations exist, each used by one action of
 * src/server/management/vercel-actions.ts behind the management pipeline:
 *
 *   redeploy  POST  /v13/deployments?forceNew=1  { name, deploymentId, target?, withLatestCommit?, meta }
 *   cancel    PATCH /v12/deployments/{id}/cancel
 *   promote   POST  /v10/projects/{projectId}/promote/{deploymentId}
 *   rollback  POST  /v1/projects/{projectId}/rollback/{deploymentId}
 *
 * Nothing else is ever sent: no project, domain, env or token mutation. The
 * transport (fixed origin, timeout, response cap, error mapping) is the
 * read client's. A unit test pins the method and path of each call.
 */

export type WriteResult = {
  status: number;
  requestId: string | null;
};

export type RedeployResult = WriteResult & {
  deployment: VercelDeploymentInfo | null;
};

export interface VercelWriteApi {
  redeploy(input: {
    deploymentId: string;
    projectName: string;
    target: "production" | null;
    withLatestCommit: boolean;
    /** Sent as `meta.devopsManagerAudit`, so an ambiguous outcome can be linked. */
    auditId: string;
  }): Promise<RedeployResult>;
  cancel(deploymentId: string): Promise<RedeployResult>;
  promote(projectId: string, deploymentId: string): Promise<WriteResult>;
  rollback(projectId: string, deploymentId: string): Promise<WriteResult>;
}

/** Promote and rollback answer 201/202 without a documented body. */
const anyBody = z.unknown();

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function checkId(id: string): string {
  if (!ID.test(id)) throw new Error("invalid Vercel id");
  return encodeURIComponent(id);
}

export function createVercelWriteClient(
  opts: VercelClientOptions,
): VercelWriteApi {
  if (!opts.teamId) throw new Error("Vercel writes need a team");
  return {
    async redeploy(input) {
      checkId(input.deploymentId);
      const res = await vercelRequest(opts, {
        method: "POST",
        path: "/v13/deployments",
        query: { forceNew: 1 },
        team: true,
        schema: deploymentSchema,
        body: {
          name: input.projectName,
          deploymentId: input.deploymentId,
          ...(input.target ? { target: input.target } : {}),
          ...(input.withLatestCommit ? { withLatestCommit: true } : {}),
          meta: { devopsManagerAudit: input.auditId },
        },
      });
      return {
        status: res.status,
        requestId: res.requestId,
        deployment: mapDeployment(res.data),
      };
    },
    async cancel(deploymentId) {
      const res = await vercelRequest(opts, {
        method: "PATCH",
        path: `/v12/deployments/${checkId(deploymentId)}/cancel`,
        query: {},
        team: true,
        schema: deploymentSchema,
      });
      return {
        status: res.status,
        requestId: res.requestId,
        deployment: mapDeployment(res.data),
      };
    },
    async promote(projectId, deploymentId) {
      const res = await vercelRequest(opts, {
        method: "POST",
        path: `/v10/projects/${checkId(projectId)}/promote/${checkId(deploymentId)}`,
        query: {},
        team: true,
        schema: anyBody,
      });
      return { status: res.status, requestId: res.requestId };
    },
    async rollback(projectId, deploymentId) {
      const res = await vercelRequest(opts, {
        method: "POST",
        path: `/v1/projects/${checkId(projectId)}/rollback/${checkId(deploymentId)}`,
        query: {},
        team: true,
        schema: anyBody,
      });
      return { status: res.status, requestId: res.requestId };
    },
  };
}

/** The message of an outcome that may or may not have happened at Vercel. */
export const OUTCOME_UNKNOWN = "outcome_unknown";

/**
 * A failed write for the audit row: Vercel's status, message and
 * `x-vercel-id`. A request that failed at the network level or timed out
 * after it was sent has an unknown outcome ("outcome_unknown: …"); the
 * reconcile step links a deployment it may have created (v7). The token of
 * the call is scrubbed by the caller.
 */
export function vercelWriteErrorInfo(error: unknown): {
  status: number | null;
  message: string;
  requestId: string | null;
} {
  if (error instanceof VercelError) {
    if (error.status === null || error.code === "timeout")
      return {
        status: null,
        message: `${OUTCOME_UNKNOWN}: ${error.message}`,
        requestId: error.requestId,
      };
    return {
      status: error.status,
      message: error.code ? `${error.code}: ${error.message}` : error.message,
      requestId: error.requestId,
    };
  }
  return {
    status: null,
    message: error instanceof Error ? error.message : "Unknown error",
    requestId: null,
  };
}
