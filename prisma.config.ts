import { defineConfig } from "prisma/config";

// Prisma 7 does not load .env files by itself. Node can, without a dotenv
// dependency; a missing file is fine (CI, Vercel and Docker pass real env).
try {
  process.loadEnvFile();
} catch {
  // no .env file
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations use the direct (non-pooled) URL when one is configured.
    // `prisma generate` never connects, so a placeholder is enough there.
    url:
      process.env.DIRECT_URL ||
      process.env.DATABASE_URL ||
      "postgresql://placeholder:placeholder@localhost:5432/placeholder",
  },
});
