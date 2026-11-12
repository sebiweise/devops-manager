/**
 * Series styles from the data colour tokens in globals.css (UI overhaul
 * §1.11): outcomes use the reserved status colours (success, failure,
 * cancelled), measures such as p50, p95 and queue time use the series
 * slots, never the success green. Class names are literal so Tailwind sees
 * them. Meaning never depends on colour alone: bars add patterns, lines add
 * dash patterns, and every chart has a legend with text labels.
 */
export const TONES = {
  success: {
    fill: "fill-status-good",
    stroke: "stroke-status-good",
    bg: "bg-status-good",
  },
  failure: {
    fill: "fill-status-critical",
    stroke: "stroke-status-critical",
    bg: "bg-status-critical",
  },
  cancelled: {
    fill: "fill-status-neutral",
    stroke: "stroke-status-neutral",
    bg: "bg-status-neutral",
  },
  other: {
    fill: "fill-series-4",
    stroke: "stroke-series-4",
    bg: "bg-series-4",
  },
  primary: {
    fill: "fill-series-1",
    stroke: "stroke-series-1",
    bg: "bg-series-1",
  },
  secondary: {
    fill: "fill-series-2",
    stroke: "stroke-series-2",
    bg: "bg-series-2",
  },
  tertiary: {
    fill: "fill-series-3",
    stroke: "stroke-series-3",
    bg: "bg-series-3",
  },
  quaternary: {
    fill: "fill-series-4",
    stroke: "stroke-series-4",
    bg: "bg-series-4",
  },
} as const;

export type Tone = keyof typeof TONES;

/** Overlay patterns that distinguish bar series without colour. */
export type BarPattern = "none" | "hatch" | "dots" | "cross";

/** Dash patterns that distinguish line series without colour. */
export const DASHES = {
  solid: undefined,
  dashed: "6 4",
  dotted: "2 3",
} as const;

export type Dash = keyof typeof DASHES;
