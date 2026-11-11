import { type NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { API_CSP, baseSecurityHeaders } from "./src/lib/csp";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  // Docker runs the standalone server; Vercel ignores this setting.
  output: "standalone",
  poweredByHeader: false,
  typedRoutes: false,
  // /api/ready compares applied migrations with the ones shipped in the build.
  outputFileTracingIncludes: {
    "/api/ready": ["./prisma/migrations/**/*"],
  },
  serverExternalPackages: ["pg"],
  async headers() {
    return [
      { source: "/(.*)", headers: baseSecurityHeaders(isDev) },
      {
        source: "/api/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: API_CSP },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);
