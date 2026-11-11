import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Integration tests: real Postgres (TEST_DATABASE_URL, migrated), a mock OIDC
 * issuer in-process and the real auth route handlers. Run with
 * `pnpm test:integration`; they are skipped without TEST_DATABASE_URL.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(
        new URL("./test/server-only-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    env: { TZ: "UTC" },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
