/**
 * Validates the configuration when the server starts. Importing the env
 * module checks every variable (OIDC settings, an admin rule,
 * ALLOWED_ACCOUNTS, ...); on failure the process exits instead of serving
 * requests with a broken configuration.
 */
try {
  await import("./env");
} catch (error) {
  console.error(
    "Refusing to start: invalid configuration.",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}

export {};
