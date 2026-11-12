"use server";

import { notFound } from "next/navigation";
import { z } from "zod";
import type { ActionResult, Denial } from "@/server/authz/action";
import { withActor } from "@/server/authz/request";
import {
  bulkMergeDependabot,
  MAX_BULK_MERGE,
  mergePullRequest,
  type BulkMergeResult,
  type MergeData,
} from "@/server/management/pulls";

/**
 * Server Actions for merging a pull request as the App (design §8.2 #9) and
 * the guarded Dependabot bulk merge (§8.2 #10), admin only, pinned to the
 * head SHAs the dialog showed.
 */

const id = z.string().regex(/^\d{1,20}$/);

const input = z.object({
  installationId: id,
  repositoryId: id,
  number: z.number().int().min(1).max(10_000_000),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  method: z.enum(["merge", "squash", "rebase"]),
  acknowledgeNotClean: z.boolean().optional(),
  confirmed: z.boolean(),
  idempotencyKey: z.uuid(),
});

export async function mergePullRequestAction(
  raw: z.input<typeof input>,
): Promise<ActionResult<MergeData> | Denial> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) notFound();
  const data = parsed.data;
  return withActor((actor) =>
    mergePullRequest(actor, {
      ...data,
      installationId: BigInt(data.installationId),
      repositoryId: BigInt(data.repositoryId),
    }),
  );
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);

const bulkInput = z.object({
  installationId: id,
  items: z
    .array(
      z.object({
        repositoryId: id,
        number: z.number().int().min(1).max(10_000_000),
        sha,
      }),
    )
    .min(1)
    .max(MAX_BULK_MERGE),
  typed: z.string().max(300),
  idempotencyKey: z.uuid(),
});

export async function bulkMergeDependabotAction(
  raw: z.input<typeof bulkInput>,
): Promise<ActionResult<BulkMergeResult> | Denial> {
  const parsed = bulkInput.safeParse(raw);
  if (!parsed.success) notFound();
  const data = parsed.data;
  return withActor((actor) =>
    bulkMergeDependabot(actor, {
      ...data,
      installationId: BigInt(data.installationId),
      items: data.items.map((i) => ({
        ...i,
        repositoryId: BigInt(i.repositoryId),
      })),
    }),
  );
}
