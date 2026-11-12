"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A disclosure menu of the app header (account switcher, Admin, user
 * menu): a button with `aria-expanded` that opens a panel of links and
 * controls. Closes on Escape (focus back on the button), on a click outside
 * and on navigation. A disclosure rather than an ARIA menu, so Tab moves
 * through the items as usual.
 */
export function HeaderMenu({
  label,
  trigger,
  children,
  align = "right",
  className,
  panelClassName,
}: {
  /** Accessible name of the button when `trigger` is an icon. */
  label?: string;
  trigger: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  // Close after navigation (state from props).
  const [path, setPath] = useState(pathname);
  if (path !== pathname) {
    setPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
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
    <div ref={ref} className={cn("relative", className)}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-expanded:bg-accent"
      >
        {trigger}
      </button>
      <div
        id={id}
        hidden={!open}
        className={cn(
          "absolute top-10 z-40 w-64 rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-lg",
          align === "right" ? "right-0" : "left-0",
          panelClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** A link row of a header menu. */
export function MenuLink({
  href,
  children,
  current,
}: {
  href: string;
  children: ReactNode;
  current?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        current && "bg-accent font-medium",
      )}
    >
      {children}
    </Link>
  );
}

/** A muted heading inside a header menu. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
      {children}
    </p>
  );
}

export function MenuSeparator() {
  return <hr className="my-1 border-border" />;
}
