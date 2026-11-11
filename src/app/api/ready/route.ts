import { readdir } from "node:fs/promises";
import path from "node:path";
import { pool } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Migration directories shipped with this build (traced into the bundle). */
async function shippedMigrations(): Promise<string[] | null> {
  try {
    const dir = path.join(process.cwd(), "prisma", "migrations");
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return null;
  }
}

/**
 * Readiness: the DB answers and every migration of this build is applied.
 * 503 otherwise, so a load balancer keeps traffic away until `migrate` ran.
 */
export async function GET() {
  try {
    await pool.query("SELECT 1");
  } catch {
    return Response.json(
      { status: "unavailable", db: "unreachable" },
      { status: 503 },
    );
  }

  const shipped = await shippedMigrations();
  let applied: string[] = [];
  try {
    const res = await pool.query<{ migration_name: string }>(
      `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    applied = res.rows.map((r) => r.migration_name);
  } catch {
    return Response.json(
      { status: "unavailable", db: "ok", migrations: "missing" },
      { status: 503 },
    );
  }

  const pending = shipped ? shipped.filter((m) => !applied.includes(m)) : [];
  if (pending.length > 0) {
    return Response.json(
      { status: "unavailable", db: "ok", pendingMigrations: pending.length },
      { status: 503 },
    );
  }
  return Response.json({
    status: "ready",
    db: "ok",
    migrations: shipped ? "applied" : "unchecked",
  });
}
