import {
  Archive,
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CirclePause,
  CircleSlash,
  CircleX,
  Clock,
  EyeOff,
  GitFork,
  Hourglass,
  Link2,
  LoaderCircle,
  Lock,
  Eye,
  Rocket,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  Unplug,
  UserRoundCheck,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { InfoTip } from "./info-tip";

/**
 * One badge for every state the pages show (UI overhaul §1.8): run
 * conclusions, runner state, queue flags, repository flags and cost flags.
 * Each is an icon plus a short text, so colour is never the only signal;
 * the colour comes from the status tokens. Badges with a definition (STUCK,
 * no matching runner, ignored, deviation) carry it in an InfoTip.
 */

type Tone = "good" | "critical" | "warning" | "neutral" | "info" | "muted";

type BadgeDef = { icon: LucideIcon; tone: Tone; info?: boolean };

const DEFS = {
  // runs and jobs
  SUCCESS: { icon: CircleCheck, tone: "good" },
  FAILURE: { icon: CircleX, tone: "critical" },
  TIMED_OUT: { icon: Clock, tone: "critical" },
  STARTUP_FAILURE: { icon: CircleX, tone: "critical" },
  CANCELLED: { icon: CircleSlash, tone: "neutral" },
  SKIPPED: { icon: CircleSlash, tone: "muted" },
  NEUTRAL: { icon: CircleDot, tone: "muted" },
  STALE: { icon: CircleDot, tone: "muted" },
  ACTION_REQUIRED: { icon: CircleAlert, tone: "warning" },
  QUEUED: { icon: Hourglass, tone: "info" },
  REQUESTED: { icon: Hourglass, tone: "info" },
  PENDING: { icon: Hourglass, tone: "info" },
  WAITING: { icon: CirclePause, tone: "warning" },
  IN_PROGRESS: { icon: LoaderCircle, tone: "info" },
  COMPLETED: { icon: CircleCheck, tone: "muted" },
  // Azure Pipelines: partially succeeded (amber, not a success)
  PARTIAL: { icon: CircleAlert, tone: "warning", info: true },
  // runners
  busy: { icon: LoaderCircle, tone: "info" },
  idle: { icon: CircleCheck, tone: "good" },
  offline: { icon: Unplug, tone: "warning" },
  // queue flags
  stuck: { icon: TriangleAlert, tone: "critical", info: true },
  noRunner: { icon: Ban, tone: "warning", info: true },
  approval: { icon: UserRoundCheck, tone: "warning", info: true },
  // repository flags
  private: { icon: Lock, tone: "muted" },
  archived: { icon: Archive, tone: "muted" },
  fork: { icon: GitFork, tone: "muted" },
  ignored: { icon: EyeOff, tone: "muted", info: true },
  // workflows
  regression: { icon: TrendingUp, tone: "warning", info: true },
  successDrop: { icon: TrendingDown, tone: "warning", info: true },
  // costs
  deviation: { icon: TriangleAlert, tone: "warning", info: true },
  // hosting (Vercel deployments)
  deployReady: { icon: CircleCheck, tone: "good" },
  deployError: { icon: CircleX, tone: "critical" },
  deployBuilding: { icon: LoaderCircle, tone: "info" },
  deployQueued: { icon: Hourglass, tone: "info" },
  deployCanceled: { icon: CircleSlash, tone: "neutral" },
  deployBlocked: { icon: Ban, tone: "warning" },
  deployUnknown: { icon: CircleDot, tone: "muted", info: true },
  production: { icon: Rocket, tone: "muted" },
  preview: { icon: Eye, tone: "muted" },
  manualLink: { icon: Link2, tone: "muted", info: true },
  autoAssignPaused: { icon: CirclePause, tone: "warning", info: true },
} as const satisfies Record<string, BadgeDef>;

export type BadgeKind = keyof typeof DEFS;

const TONE_CLASS: Record<Tone, string> = {
  good: "border-status-good/40 [&>svg]:text-status-good",
  critical:
    "border-status-critical/50 bg-status-critical/10 [&>svg]:text-status-critical",
  warning:
    "border-status-warning/60 bg-status-warning/10 [&>svg]:text-status-warning",
  neutral: "border-status-neutral/40 [&>svg]:text-status-neutral",
  info: "border-series-1/40 [&>svg]:text-series-1",
  muted: "border-border text-muted-foreground",
};

export function isBadgeKind(value: string): value is BadgeKind {
  return Object.hasOwn(DEFS, value);
}

/** Status of a run or job: its conclusion when completed, else its status. */
export function runBadgeKind(
  status: string,
  conclusion: string | null,
): BadgeKind | null {
  const key = status === "COMPLETED" && conclusion ? conclusion : status;
  return isBadgeKind(key) ? key : null;
}

export function StatusBadge({
  kind,
  label,
  className,
}: {
  kind: BadgeKind;
  /** Overrides the default text (e.g. a count "STUCK 3"). */
  label?: string;
  className?: string;
}) {
  const t = useTranslations("badge");
  const def: BadgeDef = DEFS[kind];
  const Icon = def.icon;
  const text = label ?? t(`${kind}.label`);
  return (
    <span className="inline-flex items-center gap-1">
      <span
        data-kind={kind}
        className={cn(
          "inline-flex w-fit shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:size-3",
          TONE_CLASS[def.tone],
          className,
        )}
      >
        <Icon aria-hidden="true" />
        {text}
      </span>
      {def.info ? <InfoTip label={text}>{t(`${kind}.info`)}</InfoTip> : null}
    </span>
  );
}

/** A run or job status badge; unknown statuses render as plain text. */
export function RunStatusBadge({
  status,
  conclusion,
}: {
  status: string;
  conclusion: string | null;
}) {
  const kind = runBadgeKind(status, conclusion);
  if (kind) return <StatusBadge kind={kind} />;
  return (
    <span className="text-xs text-muted-foreground">
      {status.toLowerCase().replaceAll("_", " ")}
    </span>
  );
}

/**
 * The icon of a status with its text for screen readers and as a tooltip,
 * for dense cells (the repositories' "Last run"). Unknown statuses render
 * as muted text.
 */
export function StatusIcon({
  kind,
  label,
  className,
}: {
  kind: BadgeKind | null;
  /** Overrides the default text (e.g. "Success · CI"). */
  label?: string;
  className?: string;
}) {
  const t = useTranslations("badge");
  if (!kind) return null;
  const def: BadgeDef = DEFS[kind];
  const Icon = def.icon;
  const text = label ?? t(`${kind}.label`);
  return (
    <span title={text} className={cn("inline-flex shrink-0", className)}>
      <Icon aria-hidden="true" className={cn("size-4", ICON_TONE[def.tone])} />
      <span className="sr-only">{text}</span>
    </span>
  );
}

const ICON_TONE: Record<Tone, string> = {
  good: "text-status-good",
  critical: "text-status-critical",
  warning: "text-status-warning",
  neutral: "text-status-neutral",
  info: "text-series-1",
  muted: "text-muted-foreground",
};
