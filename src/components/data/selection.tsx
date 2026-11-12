"use client";

import { useTranslations } from "next-intl";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";

/**
 * Explicit row selection for bulk actions (UI overhaul §1.7, §0 "Fork bulk
 * ignore"): a checkbox per row, a header checkbox for the page, a "Select
 * all N matching" link across pages, and a sticky bar with the count, the
 * actions and Clear. Nothing is ever pre-selected by a filter.
 */

export type SelectionItem = { id: string; label: string; fork?: boolean };

type SelectionState = {
  selected: ReadonlyMap<string, SelectionItem>;
  page: readonly SelectionItem[];
  matching: readonly SelectionItem[] | null;
  total: number;
  toggle: (item: SelectionItem, on: boolean) => void;
  /** Drops `ids` from the selection (after an action changed them). */
  deselect: (ids: readonly string[]) => void;
  setPage: (on: boolean) => void;
  selectMatching: () => void;
  clear: () => void;
};

const Ctx = createContext<SelectionState | null>(null);

/** The selection, or null outside a SelectionProvider (row actions). */
export function useOptionalSelection(): SelectionState | null {
  return useContext(Ctx);
}

export function useSelection(): SelectionState {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSelection outside SelectionProvider");
  return s;
}

export function SelectionProvider({
  page,
  matching,
  total,
  children,
}: {
  /** Rows of the current page. */
  page: SelectionItem[];
  /** Every row matching the filters (capped by the caller), for "Select all". */
  matching?: SelectionItem[] | null;
  total: number;
  children: ReactNode;
}) {
  const [stored, setSelected] = useState<Map<string, SelectionItem>>(
    () => new Map(),
  );
  // Only rows that are still selectable count: after a filter change, a
  // navigation or an ignore, ids that are neither on the page nor in the
  // matching set drop out of the bulk set.
  const selected = useMemo(() => {
    const valid = new Set([
      ...page.map((i) => i.id),
      ...(matching ?? []).map((i) => i.id),
    ]);
    const kept = [...stored].filter(([id]) => valid.has(id));
    return kept.length === stored.size ? stored : new Map(kept);
  }, [stored, page, matching]);
  const toggle = useCallback((item: SelectionItem, on: boolean) => {
    setSelected((s) => {
      const n = new Map(s);
      if (on) n.set(item.id, item);
      else n.delete(item.id);
      return n;
    });
  }, []);
  const setPage = useCallback(
    (on: boolean) =>
      setSelected((s) => {
        const n = new Map(s);
        for (const i of page) {
          if (on) n.set(i.id, i);
          else n.delete(i.id);
        }
        return n;
      }),
    [page],
  );
  const selectMatching = useCallback(() => {
    if (matching) setSelected(new Map(matching.map((i) => [i.id, i])));
  }, [matching]);
  const deselect = useCallback(
    (ids: readonly string[]) =>
      setSelected((s) => {
        const n = new Map(s);
        for (const id of ids) n.delete(id);
        return n;
      }),
    [],
  );
  const clear = useCallback(() => setSelected(new Map()), []);
  const value = useMemo(
    () => ({
      selected,
      page,
      matching: matching ?? null,
      total,
      toggle,
      deselect,
      setPage,
      selectMatching,
      clear,
    }),
    [
      selected,
      page,
      matching,
      total,
      toggle,
      deselect,
      setPage,
      selectMatching,
      clear,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function SelectRowCheckbox({ item }: { item: SelectionItem }) {
  const t = useTranslations("table");
  const s = useSelection();
  return (
    <input
      type="checkbox"
      aria-label={t("selectRow", { name: item.label })}
      checked={s.selected.has(item.id)}
      onChange={(e) => s.toggle(item, e.target.checked)}
    />
  );
}

export function SelectPageCheckbox() {
  const t = useTranslations("table");
  const s = useSelection();
  const all = s.page.length > 0 && s.page.every((i) => s.selected.has(i.id));
  const some = s.page.some((i) => s.selected.has(i.id));
  return (
    <input
      type="checkbox"
      aria-label={t("selectPage")}
      checked={all}
      ref={(el) => {
        if (el) el.indeterminate = some && !all;
      }}
      onChange={(e) => s.setPage(e.target.checked)}
      disabled={s.page.length === 0}
    />
  );
}

/** Sticky bar shown while something is selected; `children` are the actions. */
export function SelectionBar({ children }: { children: ReactNode }) {
  const t = useTranslations("table");
  const s = useSelection();
  const count = s.selected.size;
  const pageAll =
    s.page.length > 0 && s.page.every((i) => s.selected.has(i.id));
  if (count === 0) return null;
  return (
    <div
      role="region"
      aria-label={t("selection")}
      className="sticky bottom-2 z-10 flex flex-wrap items-center gap-3 rounded-lg border bg-background/95 p-2 text-sm shadow-md backdrop-blur"
    >
      <span aria-live="polite">{t("selected", { count })}</span>
      {pageAll && s.matching && s.matching.length > count ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={s.selectMatching}
        >
          {t("selectAllMatching", { n: s.matching.length })}
        </Button>
      ) : null}
      {children}
      <Button type="button" size="sm" variant="ghost" onClick={s.clear}>
        {t("clearSelection")}
      </Button>
    </div>
  );
}
