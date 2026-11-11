import { toNextJsHandler } from "better-auth/next-js";
import {
  getAuth,
  GITHUB_PROVIDER_ID,
  githubLoginEnabled,
} from "@/server/better-auth/config";
import { runWithSignInContext } from "@/server/better-auth/sign-in-context";

const handler = () => toNextJsHandler(getAuth());

/**
 * GitHub sign-in endpoints answer 404 unless GitHub login is enabled
 * (design §3.5), instead of better-auth's "provider not found" redirect.
 */
async function githubDisabled(req: Request): Promise<boolean> {
  if (githubLoginEnabled()) return false;
  const { pathname } = new URL(req.url);
  if (pathname === `/api/auth/callback/${GITHUB_PROVIDER_ID}`) return true;
  if (
    req.method === "POST" &&
    (pathname.endsWith("/sign-in/social") || pathname.endsWith("/link-social"))
  ) {
    try {
      const body = (await req.clone().json()) as { provider?: unknown };
      return body.provider === GITHUB_PROVIDER_ID;
    } catch {
      return false;
    }
  }
  return false;
}

const notFound = () => Response.json({ error: "not found" }, { status: 404 });

export async function GET(req: Request) {
  if (await githubDisabled(req)) return notFound();
  return runWithSignInContext(() => handler().GET(req));
}

export async function POST(req: Request) {
  if (await githubDisabled(req)) return notFound();
  return runWithSignInContext(() => handler().POST(req));
}
