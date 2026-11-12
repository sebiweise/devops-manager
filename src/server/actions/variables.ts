"use server";

import { notFound } from "next/navigation";
import { z } from "zod";
import type { ActionResult, Denial } from "@/server/authz/action";
import { withActor } from "@/server/authz/request";
import { MAX_NAME_LENGTH } from "@/server/management/variable-rules";
import {
  bulkSetVariable,
  deleteOrgVariable,
  deleteRepoVariable,
  previewBulkSet,
  previewRevert,
  revertBatch,
  setOrgVariable,
  setRepoVariable,
  type BulkPreview,
  type BulkResult,
  type OrgVariableChange,
  type RevertPreview,
  type VariableChange,
} from "@/server/management/variables";

/**
 * Server Actions for repository and organisation variables (design §8.2 #5
 * to #8), admin only: set, delete, bulk set with preview, batch revert with
 * preview, org variables. Names and values are checked against GitHub's
 * rules by the management module; zod only bounds the input.
 */

const id = z.string().regex(/^\d{1,20}$/);
const name = z.string().min(1).max(MAX_NAME_LENGTH);
// 48 KB of UTF-8 is at most 49,152 UTF-16 code units.
const value = z.string().min(1).max(49_152);
const typed = z.string().max(MAX_NAME_LENGTH + 10);
const key = z.uuid();
const repoIds = z.array(id).min(1).max(500);
const batchId = z.uuid();

const setInput = z.object({
  installationId: id,
  repositoryId: id,
  name,
  value,
  expectedBefore: z.string().max(49_152).nullable().optional(),
  confirmed: z.boolean(),
  idempotencyKey: key,
});

export async function setRepoVariableAction(
  raw: z.input<typeof setInput>,
): Promise<ActionResult<VariableChange> | Denial> {
  const parsed = setInput.safeParse(raw);
  if (!parsed.success) notFound();
  const d = parsed.data;
  return withActor((actor) =>
    setRepoVariable(actor, {
      ...d,
      installationId: BigInt(d.installationId),
      repositoryId: BigInt(d.repositoryId),
    }),
  );
}

const deleteInput = z.object({
  installationId: id,
  repositoryId: id,
  name,
  typed,
  idempotencyKey: key,
});

export async function deleteRepoVariableAction(
  raw: z.input<typeof deleteInput>,
): Promise<ActionResult<VariableChange> | Denial> {
  const parsed = deleteInput.safeParse(raw);
  if (!parsed.success) notFound();
  const d = parsed.data;
  return withActor((actor) =>
    deleteRepoVariable(actor, {
      ...d,
      installationId: BigInt(d.installationId),
      repositoryId: BigInt(d.repositoryId),
    }),
  );
}

const bulkPreviewInput = z.object({
  installationId: id,
  name,
  value,
  repositoryIds: repoIds,
});

export async function previewBulkSetAction(
  raw: z.input<typeof bulkPreviewInput>,
): Promise<BulkPreview | Denial> {
  const parsed = bulkPreviewInput.safeParse(raw);
  if (!parsed.success) notFound();
  const d = parsed.data;
  return withActor((actor) =>
    previewBulkSet(actor, {
      ...d,
      installationId: BigInt(d.installationId),
      repositoryIds: d.repositoryIds.map((r) => BigInt(r)),
    }),
  );
}

const bulkInput = bulkPreviewInput.extend({ typed, idempotencyKey: key });

export async function bulkSetVariableAction(
  raw: z.input<typeof bulkInput>,
): Promise<ActionResult<BulkResult> | Denial> {
  const parsed = bulkInput.safeParse(raw);
  if (!parsed.success) notFound();
  const d = parsed.data;
  return withActor((actor) =>
    bulkSetVariable(actor, {
      ...d,
      installationId: BigInt(d.installationId),
      repositoryIds: d.repositoryIds.map((r) => BigInt(r)),
    }),
  );
}

const revertPreviewInput = z.object({ installationId: id, batchId });

export async function previewRevertAction(
  raw: z.input<typeof revertPreviewInput>,
): Promise<RevertPreview | Denial> {
  const parsed = revertPreviewInput.safeParse(raw);
  if (!parsed.success) notFound();
  const d = parsed.data;
  return withActor((actor) =>
    previewRevert(actor, { ...d, installationId: BigInt(d.installationId) }),
  );
}

const revertInput = revertPreviewInput.extend({ typed, idempotencyKey: key });

export async function revertBatchAction(
  raw: z.input<typeof revertInput>,
): Promise<ActionResult<BulkResult> | Denial> {
  const parsed = revertInput.safeParse(raw);
  if (!parsed.success) notFound();
  const d = parsed.data;
  return withActor((actor) =>
    revertBatch(actor, { ...d, installationId: BigInt(d.installationId) }),
  );
}

const orgSetInput = z.object({
  installationId: id,
  name,
  value,
  visibility: z.enum(["all", "private", "selected"]),
  selectedRepositoryIds: z.array(id).max(500).optional(),
  typed,
  idempotencyKey: key,
});

export async function setOrgVariableAction(
  raw: z.input<typeof orgSetInput>,
): Promise<ActionResult<OrgVariableChange> | Denial> {
  const parsed = orgSetInput.safeParse(raw);
  if (!parsed.success) notFound();
  const d = parsed.data;
  return withActor((actor) =>
    setOrgVariable(actor, {
      ...d,
      installationId: BigInt(d.installationId),
      selectedRepositoryIds: d.selectedRepositoryIds?.map((r) => BigInt(r)),
    }),
  );
}

const orgDeleteInput = z.object({
  installationId: id,
  name,
  typed,
  idempotencyKey: key,
});

export async function deleteOrgVariableAction(
  raw: z.input<typeof orgDeleteInput>,
): Promise<ActionResult<OrgVariableChange> | Denial> {
  const parsed = orgDeleteInput.safeParse(raw);
  if (!parsed.success) notFound();
  const d = parsed.data;
  return withActor((actor) =>
    deleteOrgVariable(actor, {
      ...d,
      installationId: BigInt(d.installationId),
    }),
  );
}
