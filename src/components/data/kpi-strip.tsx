import { ArrowDown, ArrowUp, Minus, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { InfoTip } from "./info-tip";

/**
 * KPI strip and tiles (UI overhaul §1.5). A tile has a label with an
 * optional one-line definition (InfoTip), a value and one of these looks:
 *
 * - `hero`: the one headline number of a page, larger;
 * - `default`;
 * - `meter`: value / limit with a bar (the track is a lighter step of the
 *   fill's ramp; over the limit the fill turns critical and says so);
 * - `delta`: a signed change with an arrow icon, never colour alone;
 * - `status`: an icon plus count (STUCK, offline).
 *
 * `href` turns the tile into a link that applies a filter.
 */

type Base = {
  label: string;
  value: string;
  /** One-line definition shown in the InfoTip. */
  info?: string;
  hint?: ReactNode;
  href?: string;
  className?: string;
};

export type KpiTileProps =
  | (Base & { variant?: "default" | "hero" })
  | (Base & {
      variant: "meter";
      /** 0..n, the share of the limit used (may exceed 1). */
      ratio: number | null;
      /** Text for the over-limit state (shown with the icon). */
      overLabel?: string;
    })
  | (Base & {
      variant: "delta";
      /** Signed change; sign and wording carry the direction. */
      delta: number | null;
      deltaText: string;
      /** Whether up is good (success rate) or bad (duration). */
      upIsGood?: boolean;
    })
  | (Base & {
      variant: "status";
      icon: LucideIcon;
      tone: "critical" | "warning" | "neutral";
    });

const STATUS_TONE = {
  critical: "text-status-critical",
  warning: "text-status-warning",
  neutral: "text-status-neutral",
} as const;

function Body(props: KpiTileProps) {
  const variant = props.variant ?? "default";
  return (
    <>
      <dt className="relative z-10 flex w-fit items-center gap-1 text-xs text-muted-foreground">
        {props.label}
        {props.info ? (
          <InfoTip label={props.label}>{props.info}</InfoTip>
        ) : null}
      </dt>
      <dd
        className={cn(
          "flex items-center gap-1.5 font-semibold tabular-nums",
          variant === "hero" ? "text-4xl" : "text-2xl",
        )}
      >
        {props.variant === "status" ? (
          <props.icon
            aria-hidden="true"
            className={cn("size-5", STATUS_TONE[props.tone])}
          />
        ) : null}
        {props.href ? (
          // A stretched link: the whole tile is the hit target, while the
          // label (with its InfoTip button) stays above it.
          <Link
            href={props.href}
            className="rounded-sm after:absolute after:inset-0 after:rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {props.value}
          </Link>
        ) : (
          props.value
        )}
      </dd>
      {props.variant === "meter" ? <Meter {...props} /> : null}
      {props.variant === "delta" ? <Delta {...props} /> : null}
      {props.hint ? (
        <dd className="text-xs text-muted-foreground">{props.hint}</dd>
      ) : null}
    </>
  );
}

function Meter({
  ratio,
  overLabel,
}: Extract<KpiTileProps, { variant: "meter" }>) {
  if (ratio == null) return null;
  const over = ratio > 1;
  return (
    <dd className="flex flex-col gap-1">
      <span
        aria-hidden="true"
        className="relative block h-1.5 overflow-hidden rounded-full bg-seq-1/40"
      >
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-full",
            over ? "bg-status-critical" : "bg-seq-3",
          )}
          style={{
            width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`,
          }}
        />
      </span>
      {over && overLabel ? (
        <span className="text-xs font-medium">{overLabel}</span>
      ) : null}
    </dd>
  );
}

function Delta({
  delta,
  deltaText,
  upIsGood = true,
}: Extract<KpiTileProps, { variant: "delta" }>) {
  if (delta == null) return null;
  const Icon = delta > 0 ? ArrowUp : delta < 0 ? ArrowDown : Minus;
  const good = delta === 0 ? null : delta > 0 === upIsGood;
  return (
    <dd className="flex items-center gap-1 text-xs">
      <Icon
        aria-hidden="true"
        className={cn(
          "size-3",
          good === true && "text-status-good",
          good === false && "text-status-critical",
        )}
      />
      <span>{deltaText}</span>
    </dd>
  );
}

export function KpiTile(props: KpiTileProps) {
  const cls = cn(
    "flex flex-col gap-1 rounded-xl border bg-card p-4 text-card-foreground",
    props.variant === "hero" && "sm:col-span-2",
    props.href && "relative transition-colors hover:bg-accent/50",
    props.className,
  );
  return (
    <div className={cls}>
      <Body {...props} />
    </div>
  );
}

/** A responsive grid of 4 to 6 tiles. */
export function KpiStrip({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <dl
      aria-label={label}
      className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
    >
      {children}
    </dl>
  );
}
