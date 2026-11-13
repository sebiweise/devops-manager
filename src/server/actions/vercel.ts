"use server";

import { after } from "next/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { ActionResult, Denial } from "@/server/authz/action";
import { withActor } from "@/server/authz/request";
import { scheduleInstallationReconcile } from "@/server/ingest/triggers";
import {
  connectVercel,
  defaultVercelDeps,
  disconnectVercel,
  linkVercelProject,
  rotateVercelToken,
  type ConnectResult,
} from "@/server/management/vercel";
import {
  getBuildLogExcerpt,
  performVercelDeploymentAction,
  setVercelManagementEnabled,
  type BuildLogResult,
  type DeploymentActionData,
} from "@/server/management/vercel-actions";

/**
 * Server Actions of the "Hosting · Vercel" settings (admin): connect,
 * rotate, disconnect and the manual project link; and of the M6 actions:
 * redeploy, cancel, promote and roll back a deployment (operator), the
 * Vercel management toggle (admin) and the live build log excerpt
 * (operator). The token travels only in the request body of
 * connect/rotate; results never echo it. Malformed input and foreign ids
 * answer 404.
 */

const id = z.string().regex(/^\d{1,20}$/);

const tokenInput = z.object({
  installationId: id,
  token: z.string().min(1).max(512),
  teamId: z.string().max(100).optional(),
  confirmed: z.boolean(),
  idempotencyKey: z.uuid(),
});

const deps = () =>
  defaultVercelDeps({
    schedule: (installationId) =>
      scheduleInstallationReconcile(installationId, (task) => after(task)),
  });

function parseToken(raw: z.input<typeof tokenInput>) {
  const parsed = tokenInput.safeParse(raw);
  if (!parsed.success) notFound();
  return { ...parsed.data, installationId: BigInt(parsed.data.installationId) };
}

export async function connectVercelAction(
  raw: z.input<typeof tokenInput>,
): Promise<ConnectResult | Denial> {
  const data = parseToken(raw);
  return withActor((actor) => connectVercel(actor, data, deps()));
}

export async function rotateVercelTokenAction(
  raw: z.input<typeof tokenInput>,
): Promise<ConnectResult | Denial> {
  const data = parseToken(raw);
  return withActor((actor) => rotateVercelToken(actor, data, deps()));
}

const disconnectInput = z.object({
  installationId: id,
  typed: z.string().max(200),
  idempotencyKey: z.uuid(),
});

export async function disconnectVercelAction(
  raw: z.input<typeof disconnectInput>,
): Promise<ActionResult<null> | Denial> {
  const parsed = disconnectInput.safeParse(raw);
  if (!parsed.success) notFound();
  const data = {
    ...parsed.data,
    installationId: BigInt(parsed.data.installationId),
  };
  return withActor((actor) => disconnectVercel(actor, data, deps()));
}

const linkInput = z.object({
  installationId: id,
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  repositoryId: id.nullable(),
  confirmed: z.boolean(),
  idempotencyKey: z.uuid(),
});

export async function linkVercelProjectAction(
  raw: z.input<typeof linkInput>,
): Promise<ActionResult<{ repositoryId: string | null }> | Denial> {
  const parsed = linkInput.safeParse(raw);
  if (!parsed.success) notFound();
  const d = parsed.data;
  return withActor((actor) =>
    linkVercelProject(
      actor,
      {
        ...d,
        installationId: BigInt(d.installationId),
        repositoryId: d.repositoryId !== null ? BigInt(d.repositoryId) : null,
      },
      deps(),
    ),
  );
}

// ---------- M6: deployment actions, Vercel toggle, build log ----------

const vercelId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const deploymentInput = z.object({
  installationId: id,
  deploymentId: vercelId,
  operation: z.enum(["redeploy", "cancel", "promote", "rollback"]),
  withLatestCommit: z.boolean().optional(),
  confirmed: z.boolean(),
  typed: z.string().max(200).optional(),
  idempotencyKey: z.uuid(),
});

/** Redeploy, cancel, promote or roll back one deployment (operator or admin). */
export async function vercelDeploymentAction(
  raw: z.input<typeof deploymentInput>,
): Promise<ActionResult<DeploymentActionData> | Denial> {
  const parsed = deploymentInput.safeParse(raw);
  if (!parsed.success) notFound();
  const d = parsed.data;
  return withActor((actor) =>
    performVercelDeploymentAction(actor, {
      ...d,
      installationId: BigInt(d.installationId),
    }),
  );
}

const toggleInput = z.object({
  installationId: id,
  enabled: z.boolean(),
  typed: z.string().max(200),
  idempotencyKey: z.uuid(),
});

/** The Vercel management toggle (admin, TYPED team slug). */
export async function setVercelManagementAction(
  raw: z.input<typeof toggleInput>,
): Promise<ActionResult<{ enabled: boolean }> | Denial> {
  const parsed = toggleInput.safeParse(raw);
  if (!parsed.success) notFound();
  const d = parsed.data;
  return withActor((actor) =>
    setVercelManagementEnabled(actor, {
      ...d,
      installationId: BigInt(d.installationId),
    }),
  );
}

const logInput = z.object({ installationId: id, deploymentId: vercelId });

/** The live build log excerpt (operators and admins; never stored). */
export async function vercelBuildLogAction(
  raw: z.input<typeof logInput>,
): Promise<BuildLogResult | Denial> {
  const parsed = logInput.safeParse(raw);
  if (!parsed.success) notFound();
  const d = parsed.data;
  return withActor((actor) =>
    getBuildLogExcerpt(actor, {
      installationId: BigInt(d.installationId),
      deploymentId: d.deploymentId,
    }),
  );
}
