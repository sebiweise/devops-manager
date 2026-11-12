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

/**
 * Runner or job labels as small outline badges; with `max`, the first ones
 * and "+N" (all labels in its tooltip and in the row expander).
 */
export function LabelList({
  labels,
  max,
}: {
  labels: ReadonlyArray<string>;
  max?: number;
}) {
  const t = useTranslations("runners");
  if (labels.length === 0) return <span>—</span>;
  const shown = max ? labels.slice(0, max) : labels;
  const rest = labels.length - shown.length;
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((l) => (
        <Badge key={l} variant="outline" className="font-mono text-[11px]">
          {l}
        </Badge>
      ))}
      {rest > 0 ? (
        <span
          title={labels.join(", ")}
          className="text-xs text-muted-foreground"
        >
          {t("moreLabels", { count: rest })}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Utilisation as an inline meter and percentage; the sample interval (the
 * uncertainty) is in the tooltip. Insufficient samples say so in text.
 */
export function UtilisationMeter({ u }: { u: UtilisationDto }) {
  const t = useTranslations("runnerData");
  const tr = useTranslations("runners");
  const locale = useLocale();
  const interval =
    u.medianSampleIntervalS == null
      ? tr("noSamples")
      : t("sampleInterval", {
          interval: formatDuration(u.medianSampleIntervalS),
        });
  if (u.insufficientSamples || u.value == null)
    return (
      <span
        title={`${t("insufficientSamplesHint")} ${interval}`}
        className="text-xs text-muted-foreground"
      >
        {t("insufficientSamples")}
      </span>
    );
  const pct = Math.round(Math.min(1, Math.max(0, u.value)) * 100);
  return (
    <span title={interval} className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className="relative block h-1.5 w-16 overflow-hidden rounded-full bg-seq-1/40"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-seq-3"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="tabular-nums">{formatPercent(u.value, locale)}</span>
    </span>
  );
}
