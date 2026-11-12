"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId } from "react";

/**
 * Rows per page (25/50/100). Navigates on change; without JavaScript the
 * sizes are plain links inside <noscript>.
 */
export function PageSizeSelect({
  value,
  hrefs,
}: {
  value: number;
  /** size -> href with that size and page 1. */
  hrefs: Record<string, string>;
}) {
  const t = useTranslations("table");
  const router = useRouter();
  const id = useId();
  return (
    <span className="flex items-center gap-2">
      <label htmlFor={id} className="text-muted-foreground">
        {t("rowsPerPage")}
      </label>
      <select
        id={id}
        value={String(value)}
        onChange={(e) => {
          const href = hrefs[e.target.value];
          if (href) router.push(href);
        }}
        className="h-8 rounded-md border bg-background px-2 text-sm"
      >
        {Object.keys(hrefs).map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <noscript>
        {Object.entries(hrefs).map(([s, href]) => (
          <a key={s} href={href} className="ml-1 underline">
            {s}
          </a>
        ))}
      </noscript>
    </span>
  );
}
