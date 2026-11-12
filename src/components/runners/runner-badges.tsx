import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { formatDuration, formatPercent } from "@/lib/format";
import type { UtilisationDto } from "@/server/data/runners";

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
