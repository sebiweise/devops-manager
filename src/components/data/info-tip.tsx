"use client";

import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * An (i) button with a short definition (UI overhaul §1.5): keyboard
 * reachable, opens on click, Enter or Space, closes on Escape, a second
 * click or a click outside. The definition is also the button's
 * description, so screen readers hear it without opening the popover.
 */
export function InfoTip({
  label,
  children,
  className,
}: {
  /** What the tip explains, e.g. the KPI label. */
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  const t = useTranslations("table");
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <span ref={ref} className={cn("relative inline-flex", className)}>
      <button
        type="button"
        aria-label={t("info", { label })}
        aria-expanded={open}
        aria-describedby={id}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Info aria-hidden="true" className="size-3.5" />
      </button>
      <span
        id={id}
        role="tooltip"
        className={
          // Closed it is only a description; no box that could widen the page.
          open
            ? "absolute top-5 left-1/2 z-20 block w-64 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-md border bg-popover p-2 text-xs font-normal text-popover-foreground shadow-md"
            : "sr-only"
        }
      >
        {children}
      </span>
    </span>
  );
}
