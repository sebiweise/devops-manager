import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub webhook signature check (design §5.1 step 3).
 *
 * `X-Hub-Signature-256` is `sha256=` + hex(HMAC-SHA256(secret, raw body)). The
 * raw body must be the exact bytes GitHub sent; re-serialised JSON does not
 * match. Each configured secret is tried in turn (current, then previous), so
 * the secret can be rotated without dropping deliveries. The comparison is
 * constant-time after an equal-length check.
 */

export function signPayload(secret: string, raw: string | Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

export function verifySignature(
  raw: string | Uint8Array,
  header: string | null | undefined,
  secrets: ReadonlyArray<string | null | undefined>,
): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const received = Buffer.from(header, "utf8");
  let ok = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = Buffer.from(signPayload(secret, raw), "utf8");
    // Compare every secret (no early exit) so timing does not reveal which matched.
    if (
      expected.length === received.length &&
      timingSafeEqual(expected, received)
    )
      ok = true;
  }
  return ok;
}
