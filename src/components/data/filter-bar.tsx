"use client";

import { Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { first, hrefWith, toggleFilter } from "@/lib/url-state";

/**
 * Search, filter chips, sort select and quick views of a paged table (UI
 * overhaul §1.6). All state lives in the URL: the page reads it on the
 * server. Every change resets `page`. The search is debounced (300 ms) and
 * is a GET form, so it also works without JavaScript; chips and quick
 * views are links with `aria-pressed`-style state.
 */

const DEBOUNCE_MS = 300;

function useHref() {
  const pathname = usePathname();
  const sp = useSearchParams();
  return (patch: Record<string, string | number | undefined>) =>
    hrefWith(pathname, new URLSearchParams(sp.toString()), {
      ...patch,
      page: undefined,
    });
}

export function SearchBox({
  label,
  placeholder,
  className,
}: {
  label: string;
  placeholder?: string;
  className?: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const href = useHref();
  const id = useId();
  const current = first(new URLSearchParams(sp.toString()), "q") ?? "";
  const [value, setValue] = useState(current);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the box in sync with back/forward navigation (state from props).
  const [synced, setSynced] = useState(current);
  if (synced !== current) {
    setSynced(current);
    setValue(current);
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const hidden = [...new URLSearchParams(sp.toString()).entries()].filter(
    ([k]) => k !== "q" && k !== "page",
  );
  return (
    <form
      role="search"
      method="get"
      className={cn("relative flex items-center", className)}
      onSubmit={(e) => {
        e.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        router.replace(href({ q: value.trim() || undefined }));
      }}
    >
      {hidden.map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2 size-4 text-muted-foreground"
      />
      <input
        id={id}
        type="search"
        name="q"
        value={value}
        placeholder={placeholder ?? label}
        maxLength={200}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(
            () => router.replace(href({ q: v.trim() || undefined })),
            DEBOUNCE_MS,
          );
        }}
        className="h-8 w-56 rounded-md border bg-background pr-2 pl-8 text-sm"
      />
    </form>
  );
}

export type ChipOption = { value: string; label: string; count?: number };

/** Toggle chips that write `?f=a,b`. */
export function FilterChips({
  label,
  options,
  param = "f",
}: {
  label: string;
  options: ReadonlyArray<ChipOption>;
  param?: string;
}) {
  const sp = useSearchParams();
  const href = useHref();
  const active = (first(new URLSearchParams(sp.toString()), param) ?? "")
    .split(",")
    .filter(Boolean);
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = active.includes(o.value);
        const next = toggleFilter(active, o.value);
        return (
          <Link
            key={o.value}
            href={href({
              [param]: next.length > 0 ? next.join(",") : undefined,
            })}
            role="button"
            aria-pressed={on}
            replace
            scroll={false}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-full border px-3 text-xs",
              on
                ? "border-primary bg-primary text-primary-foreground"
                : "hover:bg-accent",
            )}
          >
            {o.label}
            {o.count !== undefined ? (
              <span className={cn(!on && "text-muted-foreground")}>
                {o.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}

export type SortOption = { value: string; label: string; dir: "asc" | "desc" };

/** Sort select for narrow screens; mirrors the sortable headers. */
export function SortSelect({
  label,
  options,
  value,
}: {
  label: string;
  options: ReadonlyArray<SortOption>;
  /** "<sort>:<dir>" */
  value: string;
}) {
  const router = useRouter();
  const href = useHref();
  const id = useId();
  return (
    <span className="flex items-center gap-2 text-sm">
      <label htmlFor={id} className="text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => {
          const [sort, dir] = e.target.value.split(":");
          router.replace(href({ sort, dir }));
        }}
        className="h-8 rounded-md border bg-background px-2 text-sm"
      >
        {options.map((o) => (
          <option key={`${o.value}:${o.dir}`} value={`${o.value}:${o.dir}`}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

export type QuickView = {
  id: string;
  label: string;
  sort: string;
  dir: "asc" | "desc";
  filters: readonly string[];
};

/** A segmented control of sort + filter presets (`?view=` is not needed). */
export function QuickViews({
  label,
  views,
}: {
  label: string;
  views: ReadonlyArray<QuickView>;
}) {
  const sp = useSearchParams();
  const href = useHref();
  const params = new URLSearchParams(sp.toString());
  const f = (first(params, "f") ?? "").split(",").filter(Boolean).sort();
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex flex-wrap rounded-md border p-0.5"
    >
      {views.map((v) => {
        const on =
          first(params, "sort") === v.sort &&
          (first(params, "dir") ?? "desc") === v.dir &&
          f.join(",") === [...v.filters].sort().join(",");
        return (
          <Link
            key={v.id}
            href={href({
              sort: v.sort,
              dir: v.dir,
              f:
                v.filters.length > 0
                  ? [...v.filters].sort().join(",")
                  : undefined,
            })}
            role="button"
            aria-pressed={on}
            replace
            scroll={false}
            className={cn(
              "rounded px-2.5 py-1 text-xs",
              on
                ? "bg-secondary font-medium"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v.label}
          </Link>
        );
      })}
    </div>
  );
}

/**
 * A select that writes one URL param (e.g. the repository filter `?repo=`);
 * the empty option removes it.
 */
export function ParamSelect({
  label,
  param,
  options,
  allLabel,
}: {
  label: string;
  param: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  allLabel: string;
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const href = useHref();
  const id = useId();
  const value = first(new URLSearchParams(sp.toString()), param) ?? "";
  return (
    <span className="flex items-center gap-2 text-sm">
      <label htmlFor={id} className="text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) =>
          router.replace(href({ [param]: e.target.value || undefined }))
        }
        className="h-8 max-w-56 rounded-md border bg-background px-2 text-sm"
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/** "Clear filters", shown only while a search or filter is active. */
export function ClearFilters({ keys = ["q", "f"] }: { keys?: string[] }) {
  const t = useTranslations("table");
  const sp = useSearchParams();
  const href = useHref();
  const params = new URLSearchParams(sp.toString());
  if (!keys.some((k) => first(params, k))) return null;
  return (
    <Link
      href={href(Object.fromEntries(keys.map((k) => [k, undefined])))}
      replace
      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      <X aria-hidden="true" className="size-3" />
      {t("clearFilters")}
    </Link>
  );
}

/** Layout row of the filter controls. */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {children}
    </div>
  );
}
