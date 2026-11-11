import { cn } from "@/lib/utils";
import { DASHES, TONES, type BarPattern, type Dash, type Tone } from "./tones";

export type LegendItem =
  | { label: string; tone: Tone; kind: "bar"; pattern?: BarPattern }
  | { label: string; tone: Tone; kind: "line"; dash?: Dash };

const PATTERN_CLASS: Record<BarPattern, string> = {
  none: "",
  hatch:
    "bg-[repeating-linear-gradient(45deg,transparent_0_2px,var(--background)_2px_3px)]",
  dots: "bg-[radial-gradient(var(--background)_1px,transparent_1.5px)] bg-[length:4px_4px]",
  cross:
    "bg-[repeating-linear-gradient(0deg,transparent_0_2px,var(--background)_2px_3px)]",
};

/** Text legend; swatches repeat the pattern or dash of their series. */
export function Legend({ items }: { items: ReadonlyArray<LegendItem> }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          {item.kind === "bar" ? (
            <span
              aria-hidden="true"
              className={cn(
                "relative inline-block size-3 overflow-hidden rounded-sm",
                TONES[item.tone].bg,
              )}
            >
              {item.pattern && item.pattern !== "none" ? (
                <span
                  className={cn(
                    "absolute inset-0",
                    PATTERN_CLASS[item.pattern],
                  )}
                />
              ) : null}
            </span>
          ) : (
            <svg aria-hidden="true" width="18" height="6" viewBox="0 0 18 6">
              <line
                x1="0"
                y1="3"
                x2="18"
                y2="3"
                strokeWidth="2"
                className={TONES[item.tone].stroke}
                strokeDasharray={DASHES[item.dash ?? "solid"]}
              />
            </svg>
          )}
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
