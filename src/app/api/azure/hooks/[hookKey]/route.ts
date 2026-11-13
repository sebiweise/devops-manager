import { readBodyCapped } from "@/server/ingest/webhook";
import { handleAzureHook, HOOK_MAX_BYTES } from "@/server/ingest/azure-hook";
import { prismaAzureHookStore } from "@/server/ingest/azure-hook-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Azure DevOps service hook deliveries (design addendum M7 §4.5): Basic
 * auth against the connection's hook secret, a 256 KB cap (checked before
 * and while reading), event and organisation checks, dedupe. The payload
 * only marks a build dirty; the state is read from Azure DevOps.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ hookKey: string }> },
) {
  const { hookKey } = await params;
  const tooLarge = () =>
    Response.json({ error: "payload too large" }, { status: 413 });
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > HOOK_MAX_BYTES) return tooLarge();
  const body = await readBodyCapped(req.body, HOOK_MAX_BYTES);
  if (!body) return tooLarge();
  try {
    const result = await handleAzureHook(
      { hookKey, authorization: req.headers.get("authorization"), body },
      prismaAzureHookStore,
    );
    return Response.json(result.body, { status: result.status });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
