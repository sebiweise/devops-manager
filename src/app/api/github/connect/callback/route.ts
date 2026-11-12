import { NextResponse } from "next/server";
import { env } from "@/env";
import { requireScope } from "@/server/better-auth/session";
import { completeConnect } from "@/server/billing/personal";
import { NotFoundError } from "@/server/data/installations";
import { connectEnabled } from "@/server/data/personal-billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Connect GitHub" callback (option B of the personal billing credential,
 * design §3.4). GitHub redirects here with `code` and `state` after the
 * account owner authorised the App. The state must belong to the signed-in
 * admin's pending flow; the code is exchanged with the PKCE verifier, and
 * the token is stored only if its login equals the installation's account.
 * Answers 404 unless GITHUB_CONNECT_ENABLED is set.
 */
export async function GET(req: Request) {
  if (!connectEnabled())
    return Response.json({ error: "not found" }, { status: 404 });
  const { user, scope } = await requireScope();
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const back = new URL("/admin/github", env.BETTER_AUTH_URL);

  if (url.searchParams.get("error")) {
    back.searchParams.set("connect", "denied");
    return NextResponse.redirect(back);
  }
  if (
    !/^[A-Za-z0-9_-]{1,200}$/.test(code) ||
    !/^[A-Za-z0-9_-]{16,200}$/.test(state)
  ) {
    back.searchParams.set("connect", "invalid_state");
    return NextResponse.redirect(back);
  }
  try {
    const result = await completeConnect({ user, scope }, { code, state });
    back.searchParams.set("connect", result.status);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    back.searchParams.set("connect", "invalid_state");
  }
  return NextResponse.redirect(back);
}
