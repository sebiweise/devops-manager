import { describeError } from "@/lib/describe-error";
import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import { requireScope } from "@/server/better-auth/session";
import {
  findInstallationByAccount,
  NotFoundError,
} from "@/server/data/installations";

/**
 * The visible installation of an `/o/[account]` route, shared by the layout
 * and the page of one request. An unknown or invisible account answers 404
 * (not 403), so slugs cannot be enumerated.
 */
export const loadAccount = cache(async (account: string) => {
  const { user, scope } = await requireScope();
  const installation = await findInstallationByAccount(
    scope,
    decodeURIComponent(account),
  );
  if (!installation) notFound();
  return { user, scope, installation };
});

/** Turns NotFoundError from the data layer into the 404 page. */
export async function orNotFound<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

export function accountPath(accountLogin: string, rest = ""): string {
  return `/o/${encodeURIComponent(accountLogin)}${rest}`;
}

/**
 * A live GitHub read for a page: NotFoundError becomes the 404 page, any
 * other failure (GitHub unreachable, token not mintable) becomes null so
 * the page can explain it instead of failing.
 */
export async function orUnavailable<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    console.error("live read failed", describeError(error));
    return null;
  }
}
