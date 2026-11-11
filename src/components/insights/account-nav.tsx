"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Section navigation of an installation; marks the current section. */
export function AccountNav({
  label,
  items,
}: {
  label: string;
  items: ReadonlyArray<{ href: string; label: string; exact?: boolean }>;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1 border-b pb-2">
      {items.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm",
              active ? "bg-accent font-medium" : "text-muted-foreground",
              "hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
