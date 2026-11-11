export const dynamic = "force-dynamic";

/** Liveness: the process answers. No DB access, so a DB outage does not restart the app. */
export function GET() {
  return Response.json({ status: "ok" });
}
