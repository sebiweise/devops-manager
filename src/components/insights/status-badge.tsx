import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import type { Conclusion } from "@/server/metrics/stats";

const FAILED = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"]);

/** Conclusion of a completed run or job, otherwise its status, as text. */
export async function StatusBadge({
  status,
  conclusion,
}: {
  status: string;
  conclusion: Conclusion | string | null;
}) {
  const t = await getTranslations("status");
  const key = status === "COMPLETED" && conclusion ? conclusion : status;
  const variant = FAILED.has(key)
    ? "destructive"
    : key === "SUCCESS"
      ? "secondary"
      : "outline";
  return (
    <Badge variant={variant}>
      {t.has(key) ? t(key) : key.toLowerCase().replaceAll("_", " ")}
    </Badge>
  );
}
