"use server";

import { notFound } from "next/navigation";
import { z } from "zod";
import type { ActionResult, Denial } from "@/server/authz/action";
import { withActor } from "@/server/authz/request";
import type { LiveRun } from "@/server/github/rest";
import { performRunAction } from "@/server/management/runs";

/**
 * Server Actions for run management (design §8.2 #1 to #4): re-run, re-run
 * failed jobs, cancel and force cancel, operator or admin. Ids are strings
 * (GitHub ids are BigInt); malformed input and foreign ids answer 404.
 */

const id = z.string().regex(/^\d{1,20}$/);

const input = z.object({
  installationId: id,
  runId: id,
  operation: z.enum(["rerun", "rerun_failed", "cancel", "force_cancel"]),
  enableDebugLogging: z.boolean().optional(),
  confirmed: z.boolean(),
  idempotencyKey: z.uuid(),
});

export async function runOperationAction(
  raw: z.input<typeof input>,
): Promise<ActionResult<LiveRun> | Denial> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) notFound();
  const data = parsed.data;
  return withActor((actor) =>
    performRunAction(actor, {
      installationId: BigInt(data.installationId),
      runId: BigInt(data.runId),
      operation: data.operation,
      enableDebugLogging: data.enableDebugLogging,
      confirmed: data.confirmed,
      idempotencyKey: data.idempotencyKey,
    }),
  );
}
