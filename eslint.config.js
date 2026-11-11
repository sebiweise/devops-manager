import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

/**
 * Tenant data is only read through `src/server/data`, which takes a
 * `TenantScope`. Every other module is kept away from the Prisma client so
 * that an unscoped query cannot be written by accident.
 */
const DB_ALLOWED = [
  "src/server/data/**",
  "src/server/ingest/**",
  "src/server/better-auth/**",
  "src/server/authz/**",
  "src/server/audit/**",
  "src/server/db.ts",
  "src/app/api/ready/**",
];

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "src/generated/**",
      "src/components/ui/**",
      "next-env.d.ts",
    ],
  },
  ...nextCoreWebVitals,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: DB_ALLOWED,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/generated/prisma",
                "@/generated/prisma/*",
                "@/server/db",
              ],
              message:
                "Tenant data is read through src/server/data (TenantScope). Do not import Prisma here.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
];

export default config;
