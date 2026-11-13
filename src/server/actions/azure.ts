"use server";

import { after } from "next/server";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { ActionResult, Denial } from "@/server/authz/action";
import { withActor } from "@/server/authz/request";
import { scheduleInstallationReconcile } from "@/server/ingest/triggers";
import {
  connectAzure,
  defaultAzureDeps,
  disconnectAzure,
  installAzureHooks,
  linkAzureDefinition,
  rotateAzureCredential,
  rotateAzureHookSecret,
  selectAzureProjects,
  setAzureDefinitionOsAction,
  updateAzureLimits,
  type ConnectResult,
  type HookSetup,
} from "@/server/management/azure";
import {
  getAzureLogExcerpt,
  performAzureBuildAction,
  queueAzureRun,
  setAzureManagementEnabled,
  type AzureLogResult,
  type BuildActionData,
} from "@/server/management/azure-actions";
import type { AzureLimits } from "@/server/data/azure";

/**
 * Server Actions of "CI · Azure DevOps" (admin settings) and the M7b
 * actions (operator). The credential travels only in the request body of
 * connect/rotate; results never echo it (a hook secret is returned once
 * to the admin who made it). Malformed input and foreign ids answer 404.
 */

const id = z.string().regex(/^\d{1,20}$/);
const guid = z.string().regex(/^[0-9a-f-]{36}$/i);
const key = z.uuid();

const deps = () =>
  defaultAzureDeps({
    schedule: (installationId) =>
      scheduleInstallationReconcile(
        installationId,
        (task) => after(task),
        undefined,
        {
          forceAzureDefinitions: true,
        },
      ),
  });

const connectInput = z.object({
  installationId: id,
  org: z.string().max(200).optional(),
  authKind: z.enum(["PAT", "ENTRA_SP"]),
  pat: z.string().max(512).optional(),
  tenantId: z.string().max(100).optional(),
  clientId: z.string().max(100).optional(),
  clientSecret: z.string().max(512).optional(),
  expiresAt: z.string().max(20).nullish(),
  confirmed: z.boolean(),
  idempotencyKey: key,
});

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) notFound();
  return parsed.data;
}

export async function connectAzureAction(
  raw: z.input<typeof connectInput>,
): Promise<ConnectResult | Denial> {
  const d = parse(connectInput, raw);
  return withActor((actor) =>
    connectAzure(
      actor,
      { ...d, installationId: BigInt(d.installationId) },
      deps(),
    ),
  );
}

export async function rotateAzureAction(
  raw: z.input<typeof connectInput>,
): Promise<ConnectResult | Denial> {
  const d = parse(connectInput, raw);
  return withActor((actor) =>
    rotateAzureCredential(
      actor,
      { ...d, installationId: BigInt(d.installationId) },
      deps(),
    ),
  );
}

const disconnectInput = z.object({
  installationId: id,
  typed: z.string().max(200),
  deleteHooks: z.boolean().optional(),
  idempotencyKey: key,
});

export async function disconnectAzureAction(
  raw: z.input<typeof disconnectInput>,
): Promise<ActionResult<{ hooksDeleted: number }> | Denial> {
  const d = parse(disconnectInput, raw);
  return withActor((actor) =>
    disconnectAzure(
      actor,
      { ...d, installationId: BigInt(d.installationId) },
      deps(),
    ),
  );
}

const projectsInput = z.object({
  installationId: id,
  projectIds: z.array(guid).max(500),
  confirmed: z.boolean(),
  idempotencyKey: key,
});

export async function selectAzureProjectsAction(
  raw: z.input<typeof projectsInput>,
): Promise<ActionResult<{ selected: number }> | Denial> {
  const d = parse(projectsInput, raw);
  return withActor((actor) =>
    selectAzureProjects(
      actor,
      { ...d, installationId: BigInt(d.installationId) },
      deps(),
    ),
  );
}

const linkInput = z.object({
  installationId: id,
  projectId: guid,
  definitionId: z.number().int().positive(),
  repositoryId: id.nullable(),
  confirmed: z.boolean(),
  idempotencyKey: key,
});

export async function linkAzureDefinitionAction(
  raw: z.input<typeof linkInput>,
): Promise<ActionResult<{ repositoryId: string | null }> | Denial> {
  const d = parse(linkInput, raw);
  return withActor((actor) =>
    linkAzureDefinition(
      actor,
      {
        ...d,
        projectId: d.projectId.toLowerCase(),
        installationId: BigInt(d.installationId),
        repositoryId: d.repositoryId !== null ? BigInt(d.repositoryId) : null,
      },
      deps(),
    ),
  );
}

const osInput = z.object({
  installationId: id,
  projectId: guid,
  definitionId: z.number().int().positive(),
  os: z.enum(["LINUX", "WINDOWS", "MACOS"]).nullable(),
  confirmed: z.boolean(),
  idempotencyKey: key,
});

export async function setAzureDefinitionOsServerAction(
  raw: z.input<typeof osInput>,
): Promise<ActionResult<{ os: string | null }> | Denial> {
  const d = parse(osInput, raw);
  return withActor((actor) =>
    setAzureDefinitionOsAction(
      actor,
      {
        ...d,
        projectId: d.projectId.toLowerCase(),
        installationId: BigInt(d.installationId),
      },
      deps(),
    ),
  );
}

const limitsInput = z.object({
  installationId: id,
  limits: z
    .object({
      hostedParallelJobs: z.number().int(),
      includedMinutes: z.number().int().nullable(),
      maxJobMinutes: z.number().int(),
      monthResetDay: z.number().int(),
      blockWhenQuotaExhausted: z.boolean(),
    })
    .optional(),
  adopt: z.boolean().optional(),
  confirmed: z.boolean(),
  idempotencyKey: key,
});

export async function updateAzureLimitsAction(
  raw: z.input<typeof limitsInput>,
): Promise<ActionResult<AzureLimits> | Denial> {
  const d = parse(limitsInput, raw);
  return withActor((actor) =>
    updateAzureLimits(
      actor,
      { ...d, installationId: BigInt(d.installationId) },
      deps(),
    ),
  );
}

const hooksInput = z.object({
  installationId: id,
  mode: z.enum(["auto", "manual"]),
  confirmed: z.boolean(),
  idempotencyKey: key,
});

export async function installAzureHooksAction(
  raw: z.input<typeof hooksInput>,
): Promise<ActionResult<HookSetup> | Denial> {
  const d = parse(hooksInput, raw);
  return withActor((actor) =>
    installAzureHooks(
      actor,
      { ...d, installationId: BigInt(d.installationId) },
      deps(),
    ),
  );
}

const rotateHookInput = z.object({
  installationId: id,
  confirmed: z.boolean(),
  idempotencyKey: key,
});

export async function rotateAzureHookSecretAction(
  raw: z.input<typeof rotateHookInput>,
): Promise<ActionResult<HookSetup> | Denial> {
  const d = parse(rotateHookInput, raw);
  return withActor((actor) =>
    rotateAzureHookSecret(
      actor,
      { ...d, installationId: BigInt(d.installationId) },
      deps(),
    ),
  );
}

// ---------- M7b ----------

const toggleInput = z.object({
  installationId: id,
  enabled: z.boolean(),
  typed: z.string().max(200),
  idempotencyKey: key,
});

export async function setAzureManagementAction(
  raw: z.input<typeof toggleInput>,
): Promise<ActionResult<{ enabled: boolean }> | Denial> {
  const d = parse(toggleInput, raw);
  return withActor((actor) =>
    setAzureManagementEnabled(actor, {
      ...d,
      installationId: BigInt(d.installationId),
    }),
  );
}

const queueInput = z.object({
  installationId: id,
  projectId: guid,
  definitionId: z.number().int().positive(),
  branch: z.string().max(255).nullish(),
  confirmed: z.boolean(),
  idempotencyKey: key,
});

export async function queueAzureRunAction(
  raw: z.input<typeof queueInput>,
): Promise<ActionResult<BuildActionData> | Denial> {
  const d = parse(queueInput, raw);
  return withActor((actor) =>
    queueAzureRun(actor, {
      ...d,
      projectId: d.projectId.toLowerCase(),
      installationId: BigInt(d.installationId),
    }),
  );
}

const buildInput = z.object({
  installationId: id,
  buildId: z.number().int().positive(),
  operation: z.enum(["cancel", "retry", "retryStage"]),
  stage: z.string().max(100).nullish(),
  confirmed: z.boolean(),
  idempotencyKey: key,
});

export async function azureBuildAction(
  raw: z.input<typeof buildInput>,
): Promise<ActionResult<BuildActionData> | Denial> {
  const d = parse(buildInput, raw);
  return withActor((actor) =>
    performAzureBuildAction(actor, {
      ...d,
      installationId: BigInt(d.installationId),
    }),
  );
}

const logInput = z.object({
  installationId: id,
  buildId: z.number().int().positive(),
  recordId: z.string().regex(/^[0-9a-f-]{36}$/i),
  attempt: z.number().int().min(1).max(100),
});

export async function azureLogAction(
  raw: z.input<typeof logInput>,
): Promise<AzureLogResult | Denial> {
  const d = parse(logInput, raw);
  return withActor((actor) =>
    getAzureLogExcerpt(actor, {
      ...d,
      installationId: BigInt(d.installationId),
    }),
  );
}
