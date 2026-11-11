import { readFileSync } from "node:fs";
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Validated configuration (see README "Configuration").
 *
 * Every secret also accepts a `<NAME>_FILE` variant that points to a file
 * holding the value (Docker secrets). The file wins over an empty variable,
 * a set variable wins over the file.
 *
 * Set `SKIP_ENV_VALIDATION=1` for tooling that only needs the module graph
 * (lint, unit tests, `docker build`). A running server always validates.
 */

export const FILE_SECRETS = [
  "DATABASE_URL",
  "DIRECT_URL",
  "BETTER_AUTH_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "TOKEN_ENCRYPTION_KEY_PREVIOUS",
  "CRON_SECRET",
  "AUDIT_IP_SALT",
  "OIDC_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_WEBHOOK_SECRET_PREVIOUS",
  "GITHUB_BILLING_TOKEN",
] as const;

/** Copies `<NAME>_FILE` contents into `<NAME>` when `<NAME>` is not set. */
export function resolveFileSecrets(
  source: Record<string, string | undefined>,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...source };
  for (const name of FILE_SECRETS) {
    const file = source[`${name}_FILE`];
    if (!source[name] && file) out[name] = read(file).trim();
  }
  return out;
}

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const flag = (fallback: boolean) =>
  z.preprocess(emptyToUndefined, z.stringbool().default(fallback));
const secret32 = z.string().min(32, "must be at least 32 characters");
const base64Key = z
  .string()
  .refine(
    (v) => Buffer.from(v, "base64").length === 32,
    "must be 32 bytes, base64 encoded",
  );

// Secrets from *_FILE paths are copied into process.env once, on the server.
if (typeof window === "undefined") {
  const resolved = resolveFileSecrets(process.env);
  for (const name of FILE_SECRETS) {
    if (!process.env[name] && resolved[name])
      process.env[name] = resolved[name];
  }
}

export const env = createEnv({
  server: {
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    // Core
    DATABASE_URL: z.url(),
    DIRECT_URL: z.preprocess(emptyToUndefined, z.url().optional()),
    BETTER_AUTH_SECRET: secret32,
    BETTER_AUTH_URL: z.url(),
    TOKEN_ENCRYPTION_KEY: base64Key,
    TOKEN_ENCRYPTION_KEY_PREVIOUS: z.preprocess(
      emptyToUndefined,
      base64Key.optional(),
    ),
    CRON_SECRET: secret32,
    AUDIT_IP_SALT: secret32,
    /** Comma-separated headers holding the client IP, set by the trusted proxy. */
    TRUSTED_IP_HEADERS: z.string().min(1).default("x-forwarded-for"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DEFAULT_LOCALE: z.enum(["en", "de"]).default("en"),

    // Login: OIDC primary, GitHub optional
    OIDC_ISSUER: z.url(),
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_CLIENT_SECRET: z.string().min(1),
    OIDC_PROVIDER_NAME: z.string().min(1).default("Single sign-on"),
    OIDC_SCOPES: z.string().default("openid email profile"),
    OIDC_GROUPS_CLAIM: z.string().min(1).default("groups"),
    OIDC_ALLOWED_GROUPS: optionalString,
    OIDC_REQUIRE_VERIFIED_EMAIL: flag(true),
    GITHUB_LOGIN_ENABLED: flag(false),
    SESSION_MAX_AGE_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(12),

    // Roles
    ADMIN_EMAILS: optionalString,
    ADMIN_GROUPS: optionalString,
    OPERATOR_EMAILS: optionalString,
    OPERATOR_GROUPS: optionalString,
    VIEWER_EMAILS: optionalString,
    VIEWER_GROUPS: optionalString,
    DEFAULT_ROLE: z.enum(["none", "viewer"]).default("none"),

    // GitHub App
    GITHUB_APP_ID: z.string().regex(/^\d+$/, "must be the numeric App id"),
    GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9-]+$/, "must be the App slug"),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1),
    GITHUB_APP_CLIENT_ID: optionalString,
    GITHUB_APP_CLIENT_SECRET: optionalString,
    GITHUB_WEBHOOK_SECRET: optionalString,
    GITHUB_WEBHOOK_SECRET_PREVIOUS: optionalString,
    ALLOWED_ACCOUNTS: z
      .string()
      .min(1, "list the GitHub accounts whose installations are accepted"),

    // Personal billing (M2)
    GITHUB_BILLING_TOKEN: optionalString,
    GITHUB_CONNECT_ENABLED: flag(false),

    // Management
    MANAGEMENT_ENABLED: flag(true),
    VARIABLE_PRESETS: optionalString,
    MERGE_AUDIT_TRAILER: flag(false),

    // Sync and retention
    BACKFILL_DAYS: z.coerce.number().int().min(0).default(30),
    DEFAULT_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(14)
      .max(400)
      .default(90),
    MAX_RETENTION_DAYS: z.coerce.number().int().min(0).default(90),
    LEAN_WEBHOOKS: flag(false),
    LAZY_RECONCILE_MINUTES: z.coerce.number().int().min(1).default(15),
    CRON_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(600),
    SETUP_TOKEN: optionalString,
    CSP_REPORT_ONLY: flag(false),
  },
  client: {
    NEXT_PUBLIC_APP_URL: z.url(),
  },
  experimental__runtimeEnv: {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
  createFinalSchema: (shape, isServerSide) =>
    z.object(shape).superRefine((value, ctx) => {
      if (!isServerSide) return;
      const v = value as Record<string, unknown>;
      if (!v.ADMIN_EMAILS && !v.ADMIN_GROUPS) {
        ctx.addIssue({
          code: "custom",
          path: ["ADMIN_EMAILS"],
          message:
            "set ADMIN_EMAILS or ADMIN_GROUPS: without an admin rule nobody can administer this instance",
        });
      }
      if (
        (v.GITHUB_LOGIN_ENABLED || v.GITHUB_CONNECT_ENABLED) &&
        !(v.GITHUB_APP_CLIENT_ID && v.GITHUB_APP_CLIENT_SECRET)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["GITHUB_APP_CLIENT_ID"],
          message:
            "GITHUB_LOGIN_ENABLED and GITHUB_CONNECT_ENABLED need GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET",
        });
      }
    }),
});

/** Splits a comma-separated list, trimming and dropping empty entries. */
export function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
