import { LRUCache } from "lru-cache";
import type { WebhookPayload } from "./types";

/**
 * Guards the App JWT rate limit against foreign installations (design §5.1
 * step 6). The App is public, so any account can install it and send signed
 * deliveries. Two cheap checks run before an unknown installation is looked
 * up on GitHub:
 *
 * 1. The signed payload names its owner (`repository.owner.login`,
 *    `organization.login`); an owner outside ALLOWED_ACCOUNTS is skipped
 *    without a GitHub call.
 * 2. Installation ids that GitHub already reported as unknown or foreign are
 *    remembered for a while, so repeated deliveries do not repeat the call.
 */

const REJECTED_TTL_MS = 60 * 60 * 1000;

const rejected = new LRUCache<string, true>({
  max: 10_000,
  ttl: REJECTED_TTL_MS,
});

export function isKnownForeignInstallation(id: bigint): boolean {
  return rejected.has(String(id));
}

export function rememberForeignInstallation(id: bigint): void {
  rejected.set(String(id), true);
}

/** An installation event can make a remembered id valid again. */
export function forgetForeignInstallation(id: bigint): void {
  rejected.delete(String(id));
}

/** Account logins the signed payload names as the owner of its subject. */
export function payloadOwnerLogins(payload: WebhookPayload): string[] {
  const out: string[] = [];
  const owner = payload.repository?.owner?.login;
  if (typeof owner === "string" && owner) out.push(owner);
  const org = (payload.organization as { login?: unknown } | undefined)?.login;
  if (typeof org === "string" && org) out.push(org);
  return out;
}

/** True when the payload names an owner and any named owner is not allowed. */
export function namesForeignOwner(
  payload: WebhookPayload,
  isAllowed: (login: string) => boolean,
): boolean {
  return payloadOwnerLogins(payload).some((login) => !isAllowed(login));
}
