import { z } from "zod";
import {
  AzureError,
  buildSchema,
  createAzureTransport,
  hookSubscriptionSchema,
  seg,
  type AzureBuildRaw,
  type AzureClientOptions,
} from "./client";

/**
 * The Azure DevOps write client (design addendum M7b §7.2 and the M7.4
 * service hook subscriptions). Exactly these calls exist, each used behind
 * the management pipeline or an admin setting:
 *
 *   previewRun   POST  {p}/_apis/pipelines/{def}/runs        { previewRun: true }
 *   queueRun     POST  {p}/_apis/pipelines/{def}/runs        { resources.repositories.self.refName }
 *   cancel       PATCH {p}/_apis/build/builds/{id}           { status: "cancelling" }
 *   retry        PATCH {p}/_apis/build/builds/{id}?retry=true
 *   retryStage   PATCH {p}/_apis/build/builds/{id}/stages/{stage} { state: "retry", forceRetryAllJobs: false }
 *   addTag       PUT   {p}/_apis/build/builds/{id}/tags/{tag}
 *   createHook   POST  /_apis/hooks/subscriptions
 *   deleteHook   DELETE /_apis/hooks/subscriptions/{id}
 *
 * No template parameters, variables, YAML overrides, stage skips, definition,
 * agent or pool changes are ever sent. A unit test pins every method, path
 * and body.
 */

export type WriteResult = { status: number; activityId: string | null };

const runSchema = z.object({
  id: z.number().int().nullish(),
  state: z.string().max(40).nullish(),
  result: z.string().max(40).nullish(),
});

const anyBody = z.unknown();

const REF = /^refs\/(heads|tags)\/[A-Za-z0-9._/@+-]{1,250}$/;
const STAGE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const TAG = /^[A-Za-z0-9._-]{1,100}$/;

/** refs/heads/<branch> for a branch name (validated). */
export function refNameOf(branch: string): string {
  const ref = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
  if (!REF.test(ref) || ref.includes(".."))
    throw new Error("invalid branch name");
  return ref;
}

export type HookSubscriptionInput = {
  projectId: string;
  /** ms.vss-pipelines.run-state-changed-event | ms.vss-pipelines.job-state-changed-event | build.complete */
  eventType: string;
  url: string;
  username: string;
  password: string;
};

export interface AzureWriteApi {
  previewRun(
    projectId: string,
    definitionId: number,
    refName?: string | null,
  ): Promise<WriteResult>;
  queueRun(
    projectId: string,
    definitionId: number,
    refName: string,
  ): Promise<WriteResult & { buildId: number | null }>;
  cancel(
    projectId: string,
    buildId: number,
  ): Promise<WriteResult & { build: AzureBuildRaw | null }>;
  retry(
    projectId: string,
    buildId: number,
  ): Promise<WriteResult & { build: AzureBuildRaw | null }>;
  retryStage(
    projectId: string,
    buildId: number,
    stage: string,
  ): Promise<WriteResult>;
  addTag(projectId: string, buildId: number, tag: string): Promise<WriteResult>;
  createHook(
    input: HookSubscriptionInput,
  ): Promise<WriteResult & { id: string | null }>;
  deleteHook(id: string): Promise<WriteResult>;
}

export const HOOK_PUBLISHERS: Record<string, string> = {
  "ms.vss-pipelines.run-state-changed-event": "pipelines",
  "ms.vss-pipelines.job-state-changed-event": "pipelines",
  "build.complete": "tfs",
};

/**
 * Resource version per event, from the Microsoft service hook events
 * reference (the pipelines publisher samples carry 5.1-preview.1,
 * build.complete 2.0). Still an open M7.0 probe item.
 */
export const HOOK_RESOURCE_VERSIONS: Record<string, string> = {
  "ms.vss-pipelines.run-state-changed-event": "5.1-preview.1",
  "ms.vss-pipelines.job-state-changed-event": "5.1-preview.1",
  "build.complete": "2.0",
};

export function createAzureWriteClient(
  opts: AzureClientOptions,
): AzureWriteApi {
  const t = createAzureTransport(opts);
  const def = (id: number) => {
    if (!Number.isInteger(id) || id <= 0) throw new Error("invalid id");
    return seg(id);
  };
  return {
    async previewRun(projectId, definitionId, refName) {
      const res = await t.request({
        method: "POST",
        path: `/${seg(projectId)}/_apis/pipelines/${def(definitionId)}/runs`,
        schema: anyBody,
        body: {
          previewRun: true,
          ...(refName
            ? {
                resources: {
                  repositories: { self: { refName: refNameOf(refName) } },
                },
              }
            : {}),
        },
      });
      return { status: res.status, activityId: res.activityId };
    },
    async queueRun(projectId, definitionId, refName) {
      const res = await t.request({
        method: "POST",
        path: `/${seg(projectId)}/_apis/pipelines/${def(definitionId)}/runs`,
        schema: runSchema,
        body: {
          resources: {
            repositories: { self: { refName: refNameOf(refName) } },
          },
        },
      });
      return {
        status: res.status,
        activityId: res.activityId,
        buildId: res.data.id ?? null,
      };
    },
    async cancel(projectId, buildId) {
      const res = await t.request({
        method: "PATCH",
        path: `/${seg(projectId)}/_apis/build/builds/${def(buildId)}`,
        schema: buildSchema.nullable().catch(null),
        body: { status: "cancelling" },
      });
      return {
        status: res.status,
        activityId: res.activityId,
        build: res.data,
      };
    },
    async retry(projectId, buildId) {
      const res = await t.request({
        method: "PATCH",
        path: `/${seg(projectId)}/_apis/build/builds/${def(buildId)}`,
        query: { retry: true },
        schema: buildSchema.nullable().catch(null),
        body: {},
      });
      return {
        status: res.status,
        activityId: res.activityId,
        build: res.data,
      };
    },
    async retryStage(projectId, buildId, stage) {
      if (!STAGE.test(stage)) throw new Error("invalid stage identifier");
      const res = await t.request({
        method: "PATCH",
        path: `/${seg(projectId)}/_apis/build/builds/${def(buildId)}/stages/${seg(stage)}`,
        schema: anyBody,
        body: { state: "retry", forceRetryAllJobs: false },
      });
      return { status: res.status, activityId: res.activityId };
    },
    async addTag(projectId, buildId, tag) {
      if (!TAG.test(tag)) throw new Error("invalid tag");
      const res = await t.request({
        method: "PUT",
        path: `/${seg(projectId)}/_apis/build/builds/${def(buildId)}/tags/${seg(tag)}`,
        schema: anyBody,
      });
      return { status: res.status, activityId: res.activityId };
    },
    async createHook(input) {
      const publisherId = HOOK_PUBLISHERS[input.eventType];
      const resourceVersion = HOOK_RESOURCE_VERSIONS[input.eventType];
      if (!publisherId || !resourceVersion)
        throw new Error("event type not allowed");
      if (!/^https:\/\//.test(input.url))
        throw new Error("service hooks need HTTPS");
      const res = await t.request({
        method: "POST",
        path: "/_apis/hooks/subscriptions",
        schema: hookSubscriptionSchema.partial().nullable().catch(null),
        body: {
          publisherId,
          eventType: input.eventType,
          resourceVersion,
          consumerId: "webHooks",
          consumerActionId: "httpRequest",
          publisherInputs: { projectId: input.projectId },
          consumerInputs: {
            url: input.url,
            basicAuthUsername: input.username,
            basicAuthPassword: input.password,
            resourceDetailsToSend: "minimal",
            messagesToSend: "none",
            detailedMessagesToSend: "none",
          },
        },
      });
      return {
        status: res.status,
        activityId: res.activityId,
        id: typeof res.data?.id === "string" ? res.data.id : null,
      };
    },
    async deleteHook(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id))
        throw new Error("invalid subscription id");
      const res = await t.request({
        method: "DELETE",
        path: `/_apis/hooks/subscriptions/${seg(id)}`,
        schema: anyBody,
      });
      return { status: res.status, activityId: res.activityId };
    },
  };
}

/** The message of an outcome that may or may not have happened in Azure DevOps. */
export const OUTCOME_UNKNOWN = "outcome_unknown";

/**
 * A failed write for the audit row: status, message and activity id. A
 * request that failed at the network level or timed out after it was sent
 * has an unknown outcome; the reconcile step links a build it may have
 * created (tag or probable). The credential is scrubbed by the caller.
 */
export function azureErrorInfo(error: unknown): {
  status: number | null;
  message: string;
  requestId: string | null;
} {
  if (error instanceof AzureError) {
    if (
      error.status === null ||
      error.code === "timeout" ||
      error.code === "network"
    )
      return {
        status: null,
        message: `${OUTCOME_UNKNOWN}: ${error.message}`,
        requestId: error.activityId,
      };
    return {
      status: error.status,
      message: `${error.code}: ${error.message}`,
      requestId: error.activityId,
    };
  }
  return {
    status: null,
    message: error instanceof Error ? error.message : "Unknown error",
    requestId: null,
  };
}
