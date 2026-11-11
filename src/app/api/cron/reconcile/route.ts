import { timingSafeEqual } from "node:crypto";
import { env } from "@/env";
import { discoverInstallations } from "@/server/ingest/discovery";
import { cronDeadline, reconcileAll } from "@/server/ingest/triggers";

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
 * Installation discovery first, then the deadline-aware reconcile pass:
 * delivery replay and repair, stale state, incremental sync, backfill,
 * rollups and prune. The pass stops 30 s before Vercel's deadline (240 s
 * elsewhere) and persists its cursors, so the next call resumes.
 */
async function reconcile(req: Request) {
  if (!authorized(req))
    return Response.json({ error: "unauthorized" }, { status: 401 });
  // The budget starts with the request: discovery counts against it.
  const deadline = cronDeadline();
  try {
    let discovery: Awaited<ReturnType<typeof discoverInstallations>> | null =
      null;
    try {
      discovery = await discoverInstallations();
    } catch (error) {
      // Discovery needs the App JWT; reconcile of known installations still runs.
      console.error(
        "installation discovery failed",
        error instanceof Error ? error.message : "unknown",
      );
    }
    const result = await reconcileAll(deadline);
    return Response.json({ status: "ok", discovery, reconcile: result });
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
