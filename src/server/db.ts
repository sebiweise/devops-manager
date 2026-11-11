import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { env } from "@/env";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * One Prisma client per process, on `@prisma/adapter-pg` for both Neon
 * (pooled `-pooler` URL) and plain Postgres. The pool is small and fails fast:
 * a Neon cold start beyond 5 s surfaces as an error, and the webhook route
 * answers 503 so GitHub records the failure and reconcile redelivers it.
 */

const globalForDb = globalThis as unknown as {
  prisma?: PrismaClient;
  pool?: Pool;
};

function createPool(): Pool {
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
  if (process.env.VERCEL) {
    // Lets Vercel Fluid compute close idle connections before a function suspends.
    void import("@vercel/functions").then(({ attachDatabasePool }) =>
      attachDatabasePool(pool),
    );
  }
  return pool;
}

export const pool = globalForDb.pool ?? createPool();
export const db =
  globalForDb.prisma ?? new PrismaClient({ adapter: new PrismaPg(pool) });

if (process.env.NODE_ENV !== "production") {
  globalForDb.pool = pool;
  globalForDb.prisma = db;
}
