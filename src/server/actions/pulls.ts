"use server";

import { notFound } from "next/navigation";
import { z } from "zod";
import type { ActionResult, Denial } from "@/server/authz/action";
import { withActor } from "@/server/authz/request";
import { mergePullRequest, type MergeData } from "@/server/management/pulls";

/**
 * Server Action for merging a pull request as the App (design §8.2 #9),
 * admin only, pinned to the head SHA the dialog showed.
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
