/**
 * Content-Security-Policy and the other security headers (design §9 "Web").
 *
 * Pages get a per-request nonce from `src/proxy.ts`; Next adds it to its own
 * bootstrap scripts when it finds it in the request's CSP header. Every page
 * is rendered per request anyway (session, locale cookie), so the nonce costs
 * no caching. `'strict-dynamic'` lets nonce-carrying scripts load the chunks
 * they import.
 *
 * - `style-src 'unsafe-inline'`: React and Radix set inline style attributes.
 * - `img-src`: GitHub actor avatars only. IdP profile pictures are not
 *   loaded; initials are shown instead.
 * - `form-action`: the OIDC issuer (and github.com when GitHub login is on),
 *   because a sign-in can end in a redirect to the provider.
 * - API routes return JSON and get a locked-down static policy.
 */

export type CspOptions = {
  nonce: string;
  isDev?: boolean;
  /** Extra origins for `form-action`, e.g. the OIDC issuer. */
  formActionOrigins?: string[];
  /** Only when served over https; on plain http it would break every asset. */
  upgradeInsecureRequests?: boolean;
};

export const GITHUB_AVATARS = "https://avatars.githubusercontent.com";

export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function serialize(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([name, values]) =>
      values.length > 0 ? `${name} ${values.join(" ")}` : name,
    )
    .join("; ");
}

export function pageCsp({
  nonce,
  isDev = false,
  formActionOrigins = [],
  upgradeInsecureRequests = !isDev,
}: CspOptions): string {
  return serialize({
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(isDev ? ["'unsafe-eval'"] : []),
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", GITHUB_AVATARS],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...(isDev ? ["ws:", "wss:"] : [])],
    "frame-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'", ...new Set(formActionOrigins)],
    "object-src": ["'none'"],
    "worker-src": ["'self'"],
    "manifest-src": ["'self'"],
    ...(upgradeInsecureRequests && !isDev
      ? { "upgrade-insecure-requests": [] }
      : {}),
  });
}

export const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function permissionsPolicy(): string {
  return [
    "camera=()",
    "microphone=()",
    "geolocation=()",
    "payment=()",
    "usb=()",
    "interest-cohort=()",
    "browsing-topics=()",
  ].join(", ");
}

/** HSTS for two years, without includeSubDomains/preload (a domain owner's call). */
export const STRICT_TRANSPORT_SECURITY = "max-age=63072000";

/** Headers for every response; the page CSP itself is set by the proxy. */
export function baseSecurityHeaders(
  isDev = false,
): Array<{ key: string; value: string }> {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: permissionsPolicy() },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    ...(isDev
      ? []
      : [
          {
            key: "Strict-Transport-Security",
            value: STRICT_TRANSPORT_SECURITY,
          },
        ]),
  ];
}

/** Header name honouring CSP_REPORT_ONLY (watch violations before enforcing). */
export function cspHeaderName(reportOnly: string | undefined): string {
  const v = reportOnly?.trim().toLowerCase();
  return v === "true" || v === "1"
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";
}
