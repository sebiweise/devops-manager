import "server-only";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { csv, env } from "@/env";
import { hashIp } from "@/server/better-auth/hooks";
import { requireScope } from "@/server/better-auth/session";
import { NotFoundError } from "@/server/data/installations";
import type { ActionActor, Denial } from "./action";
import { firstAddress, originAllowed } from "./origin";

/**
 * Step 1 of the management pipeline for Server Actions (design §8.1): a
 * session is required (signed-out callers are redirected to the login
 * page), and the request's Origin must be the public base URL. The actor
 * carries only an HMAC of the client IP (AUDIT_IP_SALT) and a truncated
 * user agent for the audit row.
 */
export async function actionActor(): Promise<ActionActor | null> {
  const { user, scope } = await requireScope();
  const h = await headers();
  if (!originAllowed(h.get("origin"), env.BETTER_AUTH_URL)) return null;
  let ip: string | null = null;
  for (const name of csv(env.TRUSTED_IP_HEADERS)) {
    ip = firstAddress(h.get(name));
    if (ip) break;
  }
  return {
    user: { id: user.id, name: user.name, email: user.email },
    scope,
    ipHash: ip ? hashIp(ip, env.AUDIT_IP_SALT) : null,
    userAgent: h.get("user-agent")?.slice(0, 256) ?? null,
  };
}

const FORBIDDEN: Denial = { status: "forbidden" };

/**
 * Runs a management action for a Server Action: builds the actor (origin
 * mismatch: 403) and turns NotFoundError into the 404 page, so foreign ids
 * cannot be told apart from unknown ones.
 */
export async function withActor<R>(
  run: (actor: ActionActor) => Promise<R>,
): Promise<R | Denial> {
  const actor = await actionActor();
  if (!actor) return FORBIDDEN;
  try {
    return await run(actor);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}
