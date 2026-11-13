"use server";

import { notFound } from "next/navigation";
import { z } from "zod";
import { withActor } from "@/server/authz/request";
import {
  revokeBillingCredential,
  startConnect,
  storeBillingToken,
  type CredentialActionResult,
} from "@/server/billing/personal";

/**
 * Server Actions for the personal-account billing credential (/admin/github,
 * design §3.4, §8.2 #15). Admin only; an unknown, foreign or organisation
 * installation answers 404. The session and the request's Origin are checked
 * like every management action (withActor). The token travels only in the
 * request body of `storeBillingTokenAction`: it is validated, encrypted and
 * never returned, logged or audited.
 */

const installationId = z.string().regex(/^\d{1,20}$/);

const storeInput = z.object({
  installationId,
  token: z.string().min(1).max(512),
  confirmation: z.string().max(100),
  idempotencyKey: z.uuid().optional(),
});

const connectInput = z.object({ installationId });

const revokeInput = z.object({
  installationId,
  confirmation: z.string().max(100),
  idempotencyKey: z.uuid().optional(),
});

async function guarded(
  run: Parameters<typeof withActor<CredentialActionResult>>[0],
): Promise<CredentialActionResult> {
  const result = await withActor(run);
  // An Origin mismatch answers like a missing role.
  return "status" in result && result.status === "forbidden"
    ? { status: "forbidden" }
    : (result as CredentialActionResult);
}

export async function storeBillingTokenAction(raw: {
  installationId: string;
  token: string;
  confirmation: string;
  idempotencyKey?: string;
}): Promise<CredentialActionResult> {
  const parsed = storeInput.safeParse(raw);
  if (!parsed.success) notFound();
  return guarded((actor) =>
    storeBillingToken(actor, {
      installationId: BigInt(parsed.data.installationId),
      token: parsed.data.token,
      confirmation: parsed.data.confirmation,
      idempotencyKey: parsed.data.idempotencyKey,
    }),
  );
}

/** Returns the GitHub authorize URL; the client navigates to it. */
export async function startGitHubConnectAction(raw: {
  installationId: string;
}): Promise<CredentialActionResult> {
  const parsed = connectInput.safeParse(raw);
  if (!parsed.success) notFound();
  return guarded((actor) =>
    startConnect(actor, {
      installationId: BigInt(parsed.data.installationId),
    }),
  );
}

export async function revokeBillingCredentialAction(raw: {
  installationId: string;
  confirmation: string;
  idempotencyKey?: string;
}): Promise<CredentialActionResult> {
  const parsed = revokeInput.safeParse(raw);
  if (!parsed.success) notFound();
  return guarded((actor) =>
    revokeBillingCredential(actor, {
      installationId: BigInt(parsed.data.installationId),
      confirmation: parsed.data.confirmation,
      idempotencyKey: parsed.data.idempotencyKey,
    }),
  );
}
