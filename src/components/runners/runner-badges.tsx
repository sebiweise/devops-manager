import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { formatDuration, formatPercent } from "@/lib/format";
import type { RunnerState } from "@/lib/runners-view";
import type { UtilisationDto } from "@/server/data/runners";

/** Runner state as text (busy, idle, offline); never colour alone. */
export function RunnerStateBadge({ state }: { state: RunnerState }) {
  const t = useTranslations("runners.states");
  const variant =
    state === "busy" ? "default" : state === "idle" ? "secondary" : "outline";
  return (
    <Badge
      variant={variant}
      className={state === "offline" ? "border-dashed" : ""}
    >
      {t(state)}
    </Badge>
  );
}

/** STUCK and "no matching runner" flags of a queued job or group. */
export function QueueFlagBadges({
  stuck,
  noMatchingRunner,
}: {
  stuck: boolean | number;
  noMatchingRunner: boolean;
}) {
  const t = useTranslations("runnerData");
  const tq = useTranslations("queue");
  const stuckCount = typeof stuck === "number" ? stuck : stuck ? 1 : 0;
  if (stuckCount === 0 && !noMatchingRunner) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {stuckCount > 0 ? (
        <Badge variant="destructive" title={t("stuckHint")}>
          {typeof stuck === "number"
            ? tq("stuckCount", { count: stuckCount })
            : t("stuck")}
        </Badge>
      ) : null}
      {noMatchingRunner ? (
        <Badge
          variant="outline"
          className="border-destructive text-destructive"
          title={t("noMatchingRunnerHint")}
        >
          {t("noMatchingRunner")}
        </Badge>
      ) : null}
    </span>
  );
}

/**
 * Utilisation with its uncertainty: the value and "± one sample interval
 * (<median interval>)", or "insufficient samples" below 50% coverage.
 */
export function UtilisationValue({ u }: { u: UtilisationDto }) {
  const t = useTranslations("runnerData");
  const tr = useTranslations("runners");
  const locale = useLocale();
  if (u.insufficientSamples || u.value == null) {
    return (
      <span className="flex flex-col">
        <span title={t("insufficientSamplesHint")}>
          {t("insufficientSamples")}
        </span>
        <span className="text-xs text-muted-foreground">
          {u.medianSampleIntervalS == null
            ? tr("noSamples")
            : t("sampleInterval", {
                interval: formatDuration(u.medianSampleIntervalS),
              })}
        </span>
      </span>
    );
  }
  return (
    <span className="flex flex-col">
      <span className="tabular-nums">{formatPercent(u.value, locale)}</span>
      <span className="text-xs text-muted-foreground">
        {u.medianSampleIntervalS == null
          ? tr("noSamples")
          : t("sampleInterval", {
              interval: formatDuration(u.medianSampleIntervalS),
            })}
      </span>
    </span>
  );
}

/** Runner or job labels as small outline badges. */
export function LabelList({ labels }: { labels: ReadonlyArray<string> }) {
  if (labels.length === 0) return <span>—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {labels.map((l) => (
        <Badge key={l} variant="outline" className="font-mono text-[11px]">
          {l}
        </Badge>
      ))}
    </span>
  );
}
