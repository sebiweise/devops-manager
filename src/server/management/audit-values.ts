import "server-only";
import { createHash } from "node:crypto";
import { decryptToken, encryptToken } from "@/server/crypto";

/**
 * Variable values in audit params (design §8.2 "Variable rules"). Without
 * redaction the value is stored as is. With the installation's redaction
 * setting on, the audit log stores only `sha256` and `length`, plus a copy
 * sealed with the instance key ring (AES-256-GCM, bound to the
 * installation), so "Revert batch" can still restore it. The audit read API
 * never returns the sealed copy.
 */

export type RedactedValue = { sha256: string; length: number; sealed: string };
export type AuditValue = string | null | RedactedValue;

const aad = (installationId: bigint) => `audit-variable:${installationId}`;

export function auditValue(
  value: string | null,
  redact: boolean,
  installationId: bigint,
): AuditValue {
  if (value === null || !redact) return value;
  return {
    sha256: createHash("sha256").update(value).digest("hex"),
    length: value.length,
    sealed: encryptToken(value, aad(installationId)),
  };
}

/** The plain value of an audit param; throws when a sealed copy cannot be opened. */
export function revealAuditValue(
  value: unknown,
  installationId: bigint,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    typeof (value as RedactedValue).sealed === "string"
  )
    return decryptToken((value as RedactedValue).sealed, aad(installationId));
  throw new Error("Unreadable audit value");
}
