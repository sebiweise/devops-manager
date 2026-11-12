"use server";

import { notFound } from "next/navigation";
import { z } from "zod";
import { requireScope } from "@/server/better-auth/session";
import {
  revokeBillingCredential,
  startConnect,
  storeBillingToken,
  type CredentialActionResult,
} from "@/server/billing/personal";
import { NotFoundError } from "@/server/data/installations";

/**
 * Server Actions for the personal-account billing credential (/admin/github,
 * design §3.4, §8.2 #15). Admin only; an unknown, foreign or organisation
 * installation answers 404. The token travels only in the request body of
 * `storeBillingTokenAction`: it is validated, encrypted and never returned,
 * logged or audited.
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
  run: () => Promise<CredentialActionResult>,
): Promise<CredentialActionResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

export async function storeBillingTokenAction(raw: {
  installationId: string;
  token: string;
  confirmation: string;
  idempotencyKey?: string;
}): Promise<CredentialActionResult> {
  const { user, scope } = await requireScope();
  const parsed = storeInput.safeParse(raw);
  if (!parsed.success) notFound();
  return guarded(() =>
    storeBillingToken(
      { user, scope },
      {
        installationId: BigInt(parsed.data.installationId),
        token: parsed.data.token,
        confirmation: parsed.data.confirmation,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    ),
  );
}

/** Returns the GitHub authorize URL; the client navigates to it. */
export async function startGitHubConnectAction(raw: {
  installationId: string;
}): Promise<CredentialActionResult> {
  const { user, scope } = await requireScope();
  const parsed = connectInput.safeParse(raw);
  if (!parsed.success) notFound();
  return guarded(() =>
    startConnect(
      { user, scope },
      { installationId: BigInt(parsed.data.installationId) },
    ),
  );
}

export async function revokeBillingCredentialAction(raw: {
  installationId: string;
  confirmation: string;
  idempotencyKey?: string;
}): Promise<CredentialActionResult> {
  const { user, scope } = await requireScope();
  const parsed = revokeInput.safeParse(raw);
  if (!parsed.success) notFound();
  return guarded(() =>
    revokeBillingCredential(
      { user, scope },
      {
        installationId: BigInt(parsed.data.installationId),
        confirmation: parsed.data.confirmation,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    ),
  );
}
