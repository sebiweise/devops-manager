"use server";

import { notFound } from "next/navigation";
import { z } from "zod";
import type { ChainVerification } from "@/server/audit/chain";
import type { ActionResult, Denial } from "@/server/authz/action";
import { withActor } from "@/server/authz/request";
import { verifyAuditLog } from "@/server/data/audit";
import {
  setManagementEnabled,
  setVariableRedaction,
} from "@/server/management/settings";

/**
 * Server Actions for the per-installation management settings (admin) and
 * the audit Verify button (every role that sees the installation; the
 * instance chain, id 0, is admin only).
 */

const id = z.string().regex(/^\d{1,20}$/);

const toggle = z.object({
  installationId: id,
  enabled: z.boolean(),
  confirmed: z.boolean(),
  idempotencyKey: z.uuid(),
});

type ToggleResult = ActionResult<{ enabled: boolean }> | Denial;

export async function setManagementEnabledAction(
  raw: z.input<typeof toggle>,
): Promise<ToggleResult> {
  const parsed = toggle.safeParse(raw);
  if (!parsed.success) notFound();
  const data = parsed.data;
  return withActor((actor) =>
    setManagementEnabled(actor, {
      ...data,
      installationId: BigInt(data.installationId),
    }),
  );
}

export async function setVariableRedactionAction(
  raw: z.input<typeof toggle>,
): Promise<ToggleResult> {
  const parsed = toggle.safeParse(raw);
  if (!parsed.success) notFound();
  const data = parsed.data;
  return withActor((actor) =>
    setVariableRedaction(actor, {
      ...data,
      installationId: BigInt(data.installationId),
    }),
  );
}

export async function verifyAuditChainAction(raw: {
  installationId: string;
}): Promise<ChainVerification | Denial> {
  const parsed = z.object({ installationId: id }).safeParse(raw);
  if (!parsed.success) notFound();
  const installationId = BigInt(parsed.data.installationId);
  return withActor((actor) => verifyAuditLog(actor.scope, installationId));
}
