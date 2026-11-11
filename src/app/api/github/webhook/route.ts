import { env } from "@/env";
import { handleWebhook } from "@/server/ingest/webhook";
import { prismaWebhookStore } from "@/server/ingest/webhook-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** GitHub App webhooks: verify, record, dedupe, fold inline (design §5.1). */
export async function POST(req: Request) {
  // Reject oversized bodies before reading them.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > 4 * 1024 * 1024)
    return Response.json({ error: "payload too large" }, { status: 413 });

  const body = await req.text();
  const result = await handleWebhook(
    { headers: req.headers, body },
    [env.GITHUB_WEBHOOK_SECRET, env.GITHUB_WEBHOOK_SECRET_PREVIOUS],
    prismaWebhookStore,
  );
  return Response.json(result.body, { status: result.status });
}
