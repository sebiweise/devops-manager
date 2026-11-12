import { NextResponse, type NextRequest } from "next/server";
import { cspHeaderName, originOf, pageCsp } from "@/lib/csp";

/**
 * Runs before every page request:
 *
 * 1. A per-request CSP nonce. Next reads it from the request's CSP header and
 *    puts it on its scripts; the same policy goes on the response.
 * 2. Pages of the `(app)` group need a session cookie; without one the visitor
 *    goes to /login. This is only a cheap presence check: the layout validates
 *    the session and the role (`requireScope`).
 */

const APP_PREFIXES = ["/dashboard", "/onboarding", "/o", "/settings", "/admin"];
const SESSION_COOKIES = ["__Host-dm.session_token", "dm.session_token"];

function isAppPath(pathname: string): boolean {
  return APP_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (
    isAppPath(pathname) &&
    !SESSION_COOKIES.some((name) => request.cookies.has(name))
  ) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const formActionOrigins = [originOf(process.env.OIDC_ISSUER)];
  const on = (v: string | undefined) =>
    ["true", "1", "yes"].includes((v ?? "").toLowerCase());
  // GitHub login and "Connect GitHub" (personal billing) both post to github.com.
  const githubOn =
    on(process.env.GITHUB_LOGIN_ENABLED) ||
    on(process.env.GITHUB_CONNECT_ENABLED);
  if (githubOn) formActionOrigins.push("https://github.com");
  const csp = pageCsp({
    nonce,
    isDev: process.env.NODE_ENV === "development",
    formActionOrigins: formActionOrigins.filter((o): o is string => !!o),
    upgradeInsecureRequests: (process.env.BETTER_AUTH_URL ?? "").startsWith(
      "https://",
    ),
  });
  const headerName = cspHeaderName(process.env.CSP_REPORT_ONLY);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(headerName, csp);
  return response;
}

export const config = {
  matcher: [
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:png|jpg|jpeg|svg|webp|ico|txt)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
