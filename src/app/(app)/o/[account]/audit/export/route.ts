import type { NextRequest } from "next/server";
import { parseAuditQuery } from "@/lib/audit-view";
import { hasRole } from "@/server/authz/roles";
import { requireScope } from "@/server/better-auth/session";
import { auditCsv, INSTANCE_CHAIN } from "@/server/data/audit";
import {
  findInstallationByAccount,
  NotFoundError,
} from "@/server/data/installations";

/**
 * CSV export of the audit log (design §7 /audit) with the page's filters.
 * A read: session and tenant scope as for the page, 404 for an invisible
 * account or, for non-admins, the instance chain. Cells that a spreadsheet
 * would run as a formula are escaped by `auditCsv`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ account: string }> },
): Promise<Response> {
  const { account } = await params;
  const { scope } = await requireScope();
  const installation = await findInstallationByAccount(
    scope,
    decodeURIComponent(account),
  );
  if (!installation) return new Response("Not found", { status: 404 });
  const sp = Object.fromEntries(request.nextUrl.searchParams.entries());
  const query = parseAuditQuery(sp);
  const instance = query.chain === "instance";
  if (instance && !hasRole(scope.role, "ADMIN"))
    return new Response("Not found", { status: 404 });
  const chain = instance ? INSTANCE_CHAIN : installation.id;
  let body: string;
  try {
    body = await auditCsv(scope, chain, query.filter);
  } catch (error) {
    if (error instanceof NotFoundError)
      return new Response("Not found", { status: 404 });
    throw error;
  }
  const name = instance ? "instance" : installation.accountLogin;
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
  const date = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="audit-${safe}-${date}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
