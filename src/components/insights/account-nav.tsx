"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type AccountNavItem = {
  href: string;
  label: string;
  /** Active only on exactly this path (the overview). */
  exact?: boolean;
  /** Other path prefixes that mark this section (run pages → Repositories). */
  activePrefixes?: readonly string[];
};

export type AccountNavGroup = {
  label: string;
  items: ReadonlyArray<AccountNavItem>;
};

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * Navigation feedback without a route-level loading boundary (which would
 * turn 404 answers into streamed 200s): a bar under the clicked tab while
 * its page renders.
 */
function PendingHint() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-3 -bottom-0.5 h-0.5 rounded-full bg-series-1 opacity-0 transition-opacity",
        pending && "animate-pulse opacity-100",
      )}
    />
  );
}

export function isActive(pathname: string, item: AccountNavItem): boolean {
  if (item.exact) return pathname === item.href;
  return (
    under(pathname, item.href) ||
    (item.activePrefixes ?? []).some((p) => under(pathname, p))
  );
}

/**
 * Section navigation of an account (UI overhaul §1.2), in groups (Insights,
 * Manage, Audit) separated by a divider, with small group labels from `lg`.
 * Below `md` the row scrolls sideways and the active tab is scrolled into
 * view.
 */
export function AccountNav({
  label,
  groups,
}: {
  label: string;
  groups: ReadonlyArray<AccountNavGroup>;
}) {
  const pathname = usePathname();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-current="page"]');
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <nav
      ref={ref}
      aria-label={label}
      className="-mx-4 [scrollbar-width:none] overflow-x-auto border-b px-4 sm:mx-0 sm:px-0"
    >
      <ul className="flex w-max snap-x items-end gap-1 md:w-auto md:flex-wrap">
        {groups.map((g, gi) => (
          <Fragment key={g.label}>
            {gi > 0 ? (
              <li
                aria-hidden="true"
                className="mx-1 mb-2 h-5 w-px self-end bg-border"
              />
            ) : null}
            <li className="flex flex-col">
              <span className="hidden px-3 pt-1 text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase lg:block">
                {g.label}
              </span>
              <ul className="flex gap-1" aria-label={g.label}>
                {g.items.map((item) => {
                  const active = isActive(pathname, item);
                  return (
                    <li key={item.href} className="snap-start">
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "relative -mb-px inline-flex border-b-2 px-3 py-2 text-sm whitespace-nowrap",
                          active
                            ? "border-foreground font-medium text-foreground"
                            : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                        )}
                      >
                        {item.label}
                        <PendingHint />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </li>
          </Fragment>
        ))}
      </ul>
    </nav>
  );
}
