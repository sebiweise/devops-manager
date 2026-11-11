/**
 * Series styles. Colours come from the shadcn theme variables
 * (`--chart-n`, `--destructive`, `--muted-foreground`), so light and dark
 * mode follow the theme. Class names are literal so Tailwind sees them.
 * Meaning never depends on colour alone: bars add patterns, lines add dash
 * patterns, and every chart has a legend with text labels.
 */
export const TONES = {
  success: { fill: "fill-chart-2", stroke: "stroke-chart-2", bg: "bg-chart-2" },
  failure: {
    fill: "fill-destructive",
    stroke: "stroke-destructive",
    bg: "bg-destructive",
  },
  cancelled: {
    fill: "fill-muted-foreground",
    stroke: "stroke-muted-foreground",
    bg: "bg-muted-foreground",
  },
  other: { fill: "fill-chart-4", stroke: "stroke-chart-4", bg: "bg-chart-4" },
  primary: { fill: "fill-chart-2", stroke: "stroke-chart-2", bg: "bg-chart-2" },
  secondary: {
    fill: "fill-chart-1",
    stroke: "stroke-chart-1",
    bg: "bg-chart-1",
  },
  tertiary: {
    fill: "fill-chart-3",
    stroke: "stroke-chart-3",
    bg: "bg-chart-3",
  },
  quaternary: {
    fill: "fill-chart-5",
    stroke: "stroke-chart-5",
    bg: "bg-chart-5",
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
