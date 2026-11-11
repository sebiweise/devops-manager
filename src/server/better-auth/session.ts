import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { getScope, type TenantScope } from "@/server/authz/scope";
import { hasRole, type Role } from "@/server/authz/roles";
import { db } from "@/server/db";
import { getAuth } from "./config";

export const getSession = cache(async () => {
  // headers() first: during `next build` it bails out before auth is created.
  const requestHeaders = await headers();
  return getAuth().api.getSession({ headers: requestHeaders });
});

export type ScopedSession = {
  user: { id: string; name: string; email: string; locale: string | null };
  scope: TenantScope;
};

/**
 * Session plus tenant scope for `(app)` pages. Signed-out visitors go to the
 * login page. A user whose role no longer resolves (env changed, disabled) is
 * signed out everywhere and sent to the login page with `no_access`.
 */
export const requireScope = cache(async (): Promise<ScopedSession> => {
  const session = await getSession();
  if (!session) redirect("/login");
  const scope = await getScope(session.user.id);
  if (!scope) {
    await db.session.deleteMany({ where: { userId: session.user.id } });
    redirect("/login?error=no_access");
  }
  const user = session.user as typeof session.user & { locale?: string | null };
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      locale: user.locale ?? null,
    },
    scope,
  };
});

/** Like `requireScope`, but pages for higher roles answer 404 to everyone else. */
export async function requireRole(role: Role): Promise<ScopedSession> {
  const scoped = await requireScope();
  if (!hasRole(scoped.scope.role, role)) notFound();
  return scoped;
}
