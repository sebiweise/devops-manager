import { timingSafeEqual } from "node:crypto";
import { env } from "@/env";
import { discoverInstallations } from "@/server/ingest/discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${env.CRON_SECRET}`, "utf8");
  const received = Buffer.from(header, "utf8");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

/**
 * Reconcile (design §5.3). Called by the daily Vercel cron and the Docker cron
 * sidecar with `Authorization: Bearer CRON_SECRET`.
 *
 * M0 runs the installation and repository discovery only; delivery replay,
 * incremental sync, backfill, rollups and prune follow in M1.
 */
async function reconcile(req: Request) {
  if (!authorized(req))
    return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const discovery = await discoverInstallations();
    return Response.json({ status: "ok", discovery });
  } catch (error) {
    console.error(
      "reconcile failed",
      error instanceof Error ? error.message : "unknown",
    );
    return Response.json({ status: "error" }, { status: 500 });
  }
}

export const GET = reconcile;
export const POST = reconcile;
