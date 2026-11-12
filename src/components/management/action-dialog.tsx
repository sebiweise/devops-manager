"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { resultText, type ResultLike } from "@/lib/management-view";

/**
 * The confirmation dialog of the management actions (design §8.1 step 6): a
 * trigger button and a native modal `<dialog>` (focus trap, Escape and the
 * inert background come from the browser). The body is mounted only while
 * the dialog is open, so every opening gets a fresh idempotency key. The
 * page is refreshed on close when the body reported a change, so a result
 * stays readable until the dialog is closed.
 */

export type DialogControls = {
  close: () => void;
  /** Marks that GitHub state changed; the page refreshes on close. */
  changed: () => void;
};

export function ActionDialog({
  trigger,
  triggerLabel,
  title,
  triggerVariant = "outline",
  triggerSize = "sm",
  disabled,
  children,
}: {
  trigger: ReactNode;
  /** Accessible name when the trigger text alone is ambiguous. */
  triggerLabel?: string;
  title: string;
  triggerVariant?:
    "default" | "outline" | "destructive" | "secondary" | "ghost";
  triggerSize?: "xs" | "sm" | "default";
  disabled?: boolean;
  children: (controls: DialogControls) => ReactNode;
}) {
  const t = useTranslations("management.dialog");
  const router = useRouter();
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (open && dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
  }, [open, dialog]);

  const onClosed = useCallback(() => {
    setOpen(false);
    if (dirty) {
      setDirty(false);
      router.refresh();
    }
  }, [dirty, router]);

  const changed = useCallback(() => setDirty(true), []);

  const close = useCallback(() => {
    if (dialog?.open && typeof dialog.close === "function") dialog.close();
    else onClosed();
  }, [dialog, onClosed]);

  return (
    <>
      <Button
        type="button"
        variant={triggerVariant}
        size={triggerSize}
        disabled={disabled}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {trigger}
      </Button>
      {open ? (
        <dialog
          ref={setDialog}
          aria-labelledby={titleId}
          onClose={onClosed}
          className="m-auto w-[min(40rem,calc(100vw-2rem))] rounded-xl border bg-background p-0 text-foreground shadow-lg backdrop:bg-black/50"
        >
          <div className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-5">
            <div className="flex items-start justify-between gap-3">
              <h2 id={titleId} className="text-lg font-semibold">
                {title}
              </h2>
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                {t("close")}
              </Button>
            </div>
            {children({ close, changed })}
          </div>
        </dialog>
      ) : null}
    </>
  );
}

/** The live region that announces an action's result. */
export function ResultMessage({
  result,
  className,
}: {
  result: ResultLike | undefined;
  className?: string;
}) {
  const t = useTranslations("management");
  const text = result ? resultText(result) : null;
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        "text-sm",
        text?.tone === "error" && "text-destructive",
        className,
      )}
    >
      {text ? t(text.key, text.values) : null}
    </p>
  );
}
