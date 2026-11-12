import "server-only";
import { after } from "next/server";
import { maybeLazyRunnerSample } from "@/server/ingest/triggers";

/**
 * Lazy runner sample of the live pages (/runners, /queue; design §5.3 f):
 * at most once per two minutes per installation, run in `after()` so the
 * page renders from stored data right away. Returns true when this view
 * scheduled it. Best effort: a failure never breaks the page.
 */
export async function lazyRunnerSample(
  installationId: bigint,
): Promise<boolean> {
  try {
    return await maybeLazyRunnerSample(installationId, (task) => after(task));
  } catch (error) {
    console.error(
      "lazy runner sample not scheduled",
      error instanceof Error ? error.message : "unknown",
    );
    return false;
  }
}
