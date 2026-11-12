"use client";

import { CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { SyncNowButton } from "@/components/sync-now-button";
import { cn } from "@/lib/utils";

/**
 * Data freshness in the account header (UI overhaul §1.10): "Data updated
 * 3 min ago" with a popover holding the last webhook, the last full sync
 * with GitHub, Sync now (operator+) and a link to "Settings & sync"
 * (admin). With stale reasons the chip turns to a warning; the full banner
 * is rendered by the page under the header.
 */
export function FreshnessChip({
  lastWebhookAt,
  lastReconciledAt,
  stale,
  installationId,
  canSync,
  settingsHref,
  now,
  refreshing = false,
}: {
  lastWebhookAt: string | null;
  lastReconciledAt: string | null;
  stale: boolean;
  installationId: string;
  canSync: boolean;
  settingsHref?: string;
  /** Server render time, so the first paint matches the server. */
  now: string;
  /** A background full sync was just started for this view. */
  refreshing?: boolean;
}) {
  const t = useTranslations("shell.freshness");
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const at = new Date(now);
  const ago = (iso: string | null) =>
    iso ? format.relativeTime(new Date(iso), at) : t("never");
  const updated = [lastWebhookAt, lastReconciledAt]
    .filter((v): v is string => !!v)
    .sort()
    .pop();

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

  const Icon = refreshing ? LoaderCircle : stale ? TriangleAlert : CircleCheck;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs",
          stale
            ? "border-status-warning/60 bg-status-warning/10"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Icon
          aria-hidden="true"
          className={cn(
            "size-3.5",
            refreshing && "animate-spin text-muted-foreground",
            !refreshing && (stale ? "text-status-warning" : "text-status-good"),
          )}
        />
        {updated ? t("updated", { ago: ago(updated) }) : t("notYet")}
        {stale ? <span className="sr-only">{t("stale")}</span> : null}
      </button>
      {open ? (
        <div
          id={id}
          role="dialog"
          aria-label={t("title")}
          className="absolute top-9 right-0 z-30 flex w-72 flex-col gap-2 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-md"
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{t("lastWebhook")}</dt>
            <dd>{ago(lastWebhookAt)}</dd>
            <dt className="text-muted-foreground">{t("lastSync")}</dt>
            <dd>{ago(lastReconciledAt)}</dd>
          </dl>
          {refreshing ? <p className="text-xs">{t("refreshing")}</p> : null}
          {stale ? <p className="text-xs">{t("staleHint")}</p> : null}
          {canSync ? <SyncNowButton installationId={installationId} /> : null}
          {settingsHref ? (
            <Link
              href={settingsHref}
              className="text-xs underline-offset-2 hover:underline"
            >
              {t("settings")}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
