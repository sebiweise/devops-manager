import "server-only";
import type { FindingSource } from "@/generated/prisma/client";
import { tokenKeyRing } from "@/server/crypto";
import { db } from "@/server/db";
import { Deadline } from "./budget";
import { redactError } from "./webhook";

/**
 * Helpers shared by the external provider steps (design addendum M7 §2.3):
 * Vercel (step v) and Azure DevOps (step z). Extracted from the Vercel step
 * without changing its behaviour; vercel-reconcile.ts re-exports the
 * finding helpers under their old names.
 *
 * - `stepDeadline`: a provider's own budget inside the pass deadline.
 * - `raiseFinding` / `resolveFindings`: stable rule keys; a dismissed
 *   finding stays dismissed, a fixed one opens again.
 * - `planProviderPhase`: how a pass splits its provider phase.
 * - `reencryptColumns`: the k2 re-encryption of provider secrets.
 */

/** A provider's budget, never past the outer deadline. */
export function stepDeadline(outer: Deadline, budgetMs: number): Deadline {
  return new Deadline(Math.min(outer.endsAt, outer.now() + budgetMs), () =>
    outer.now(),
  );
}

export type ProviderFindingSource = Extract<
  FindingSource,
  "VERCEL" | "CREDENTIAL" | "AZURE_PIPELINES"
>;

export type FindingInput = {
  source: ProviderFindingSource;
  ruleKey: string;
  repositoryId: bigint | null;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  title: string;
  externalUrl: string | null;
  details: Record<string, string | number | boolean | null>;
};

/** Opens or refreshes a finding (ruleKey is stable). */
export async function raiseFinding(
  installationId: bigint,
  f: FindingInput,
  now: Date,
): Promise<void> {
  const existing = await db.finding.findFirst({
    where: {
      installationId,
      source: f.source,
      ruleKey: f.ruleKey,
      repositoryId: f.repositoryId,
    },
    select: { id: true, status: true },
  });
  const data = {
    severity: f.severity,
    title: f.title.slice(0, 200),
    externalUrl: f.externalUrl,
    details: f.details,
    lastSeenAt: now,
  };
  if (!existing) {
    await db.finding.create({
      data: {
        installationId,
        source: f.source,
        ruleKey: f.ruleKey,
        repositoryId: f.repositoryId,
        status: "OPEN",
        firstSeenAt: now,
        ...data,
      },
    });
    return;
  }
  await db.finding.update({
    where: { id: existing.id },
    data: {
      ...data,
      // A dismissed finding stays dismissed; a fixed one opens again.
      ...(existing.status === "FIXED"
        ? { status: "OPEN", firstSeenAt: now, resolvedAt: null }
        : {}),
    },
  });
}

/** Marks open findings with this rule-key prefix fixed, except `keep`. */
export async function resolveFindings(
  installationId: bigint,
  source: ProviderFindingSource,
  prefix: string,
  keep: ReadonlyArray<string>,
  now: Date,
): Promise<void> {
  await db.finding.updateMany({
    where: {
      installationId,
      source,
      status: "OPEN",
      ruleKey: { startsWith: prefix, notIn: [...keep] },
    },
    data: { status: "FIXED", resolvedAt: now },
  });
}

// ---------- provider phase ----------

export type ProviderName = "vercel" | "azure";

export type ProviderPlan = Array<{ provider: ProviderName; budgetMs: number }>;

/** Budgets of the provider phase (design addendum M7 §4.2). */
export const PROVIDER_PHASE = {
  /** Cron: Vercel keeps its 25 s, Azure DevOps gets 30 s after it. */
  cron: { vercel: 25_000, azure: 30_000 },
  /** Sync now and lazy reconcile (60 s pass): at most 25 s for all providers. */
  interactiveTotalMs: 25_000,
  /** The provider synced longer ago goes first with 15 s… */
  interactiveFirstMs: 15_000,
  /** …the other gets the rest, at least 10 s, or it is skipped. */
  interactiveMinMs: 10_000,
} as const;

/**
 * The order and budgets of the connected providers. Cron passes run both
 * one after the other with their own budgets. Interactive passes (Sync now,
 * lazy) keep GitHub at 35 s or more: a single provider gets up to 25 s;
 * with two, the one synced longer ago goes first with 15 s and the other
 * gets what is left of the 25 s (skipped below 10 s).
 */
export function planProviderPhase(
  mode: "cron" | "interactive",
  providers: ReadonlyArray<{
    provider: ProviderName;
    lastSyncedAt: Date | null;
  }>,
): ProviderPlan {
  if (providers.length === 0) return [];
  if (mode === "cron")
    return [...providers]
      .sort((a, b) =>
        a.provider === "vercel" ? -1 : b.provider === "vercel" ? 1 : 0,
      )
      .map((p) => ({
        provider: p.provider,
        budgetMs: PROVIDER_PHASE.cron[p.provider],
      }));
  if (providers.length === 1)
    return [
      {
        provider: providers[0]!.provider,
        budgetMs: PROVIDER_PHASE.interactiveTotalMs,
      },
    ];
  const ordered = [...providers].sort(
    (a, b) =>
      (a.lastSyncedAt?.getTime() ?? 0) - (b.lastSyncedAt?.getTime() ?? 0),
  );
  const rest =
    PROVIDER_PHASE.interactiveTotalMs - PROVIDER_PHASE.interactiveFirstMs;
  return [
    {
      provider: ordered[0]!.provider,
      budgetMs: PROVIDER_PHASE.interactiveFirstMs,
    },
    ...(rest >= PROVIDER_PHASE.interactiveMinMs
      ? [{ provider: ordered[1]!.provider, budgetMs: rest }]
      : []),
  ];
}

/**
 * The rest of a shared budget after `spentMs` (interactive passes): the
 * second provider gets what the first left, at least 10 s, or nothing.
 */
export function remainingProviderBudget(
  spentMs: number,
  plannedMs: number,
): number {
  const left = Math.min(plannedMs, PROVIDER_PHASE.interactiveTotalMs - spentMs);
  return left >= PROVIDER_PHASE.interactiveMinMs ? left : 0;
}

// ---------- k2 re-encryption registry ----------

export type EncryptedColumn = {
  label: string;
  /** Rows (id plus the ciphertexts) after `after`, 50 at a time. */
  load(
    after: bigint | undefined,
  ): Promise<Array<{ id: bigint; values: Record<string, string | null> }>>;
  aad(id: bigint, column: string): string;
  /** Writes the new ciphertexts only where the row still holds the old ones. */
  save(
    id: bigint,
    before: Record<string, string | null>,
    after: Record<string, string>,
  ): Promise<void>;
};

/**
 * Re-encrypts every column of the registry whose ciphertext was written
 * with a key other than the current one (reconcile k2), until done or
 * expired. A value that fails to decrypt is left as is and logged without
 * its value.
 */
export async function reencryptColumns(
  columns: ReadonlyArray<EncryptedColumn>,
  expired: () => boolean,
): Promise<{ reencrypted: number; failed: number }> {
  const ring = tokenKeyRing();
  let reencrypted = 0;
  let failed = 0;
  for (const col of columns) {
    let after: bigint | undefined;
    for (;;) {
      if (expired()) return { reencrypted, failed };
      const rows = await col.load(after);
      if (rows.length === 0) break;
      for (const r of rows) {
        try {
          const next: Record<string, string> = {};
          for (const [name, value] of Object.entries(r.values)) {
            if (!value || !ring.needsReencrypt(value)) continue;
            const aad = col.aad(r.id, name);
            next[name] = ring.encrypt(ring.decrypt(value, aad), aad);
          }
          if (Object.keys(next).length > 0) {
            await col.save(r.id, r.values, next);
            reencrypted++;
          }
        } catch (error) {
          failed++;
          console.warn(
            `re-encrypt skipped a ${col.label}`,
            redactError(
              error instanceof Error ? error.message : "unknown",
              120,
            ),
          );
        }
      }
      after = rows[rows.length - 1]!.id;
    }
  }
  return { reencrypted, failed };
}
