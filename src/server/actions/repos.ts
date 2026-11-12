"use server";

import { notFound } from "next/navigation";
import { z } from "zod";
import type { ActionResult, Denial } from "@/server/authz/action";
import { withActor } from "@/server/authz/request";
import {
  ignoreRepositories,
  MAX_IGNORE_REPOS,
  unignoreRepositories,
  type IgnoreResult,
} from "@/server/management/repos";

/**
 * Server Actions to ignore and un-ignore repositories (UI overhaul §3.2),
 * admin only, DIALOG confirmation, audited per repository.
 */

const id = z.string().regex(/^\d{1,20}$/);

const input = z.object({
  installationId: id,
  repositoryIds: z.array(id).min(1).max(MAX_IGNORE_REPOS),
  confirmed: z.boolean(),
  idempotencyKey: z.uuid(),
});

type Result = ActionResult<IgnoreResult> | Denial;

function parse(raw: z.input<typeof input>) {
  const parsed = input.safeParse(raw);
  if (!parsed.success) notFound();
  const d = parsed.data;
  return {
    ...d,
    installationId: BigInt(d.installationId),
    repositoryIds: d.repositoryIds.map((r) => BigInt(r)),
  };
}

export async function ignoreRepositoriesAction(
  raw: z.input<typeof input>,
): Promise<Result> {
  const data = parse(raw);
  return withActor((actor) => ignoreRepositories(actor, data));
}

export async function unignoreRepositoriesAction(
  raw: z.input<typeof input>,
): Promise<Result> {
  const data = parse(raw);
  return withActor((actor) => unignoreRepositories(actor, data));
}
