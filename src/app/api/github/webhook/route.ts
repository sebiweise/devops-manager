import { env } from "@/env";
import {
  handleWebhook,
  MAX_BODY_BYTES,
  readBodyCapped,
} from "@/server/ingest/webhook";
import { prismaWebhookStore } from "@/server/ingest/webhook-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** GitHub App webhooks: verify, record, dedupe, fold inline (design §5.1). */
export async function POST(req: Request) {
  // Reject oversized bodies before reading them, and stop reading once the
  // body passes the cap (chunked uploads have no Content-Length). The bytes
  // stay raw so the HMAC covers exactly what was sent.
  const tooLarge = () =>
    Response.json({ error: "payload too large" }, { status: 413 });
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return tooLarge();

  const body = await readBodyCapped(req.body, MAX_BODY_BYTES);
  if (!body) return tooLarge();
  const result = await handleWebhook(
    { headers: req.headers, body },
    [env.GITHUB_WEBHOOK_SECRET, env.GITHUB_WEBHOOK_SECRET_PREVIOUS],
    prismaWebhookStore,
  );
  return Response.json(result.body, { status: result.status });
}
