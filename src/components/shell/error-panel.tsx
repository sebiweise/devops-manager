"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/**
 * The localized error boundary content (UI overhaul §1.12): what happened,
 * "Try again" (reset) and a way back. The error message itself is not
 * shown (it may contain internals); the digest lets an admin find the log.
 */
export function ErrorPanel({
  digest,
  reset,
  backHref,
  backLabel,
}: {
  digest?: string;
  reset: () => void;
  backHref: string;
  backLabel: "backToAccount" | "backToStart";
}) {
  const t = useTranslations("errors");
  return (
    <section
      role="alert"
      className="flex max-w-prose flex-col gap-3 rounded-xl border p-6"
    >
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      {digest ? (
        <p className="font-mono text-xs text-muted-foreground">
          {t("digest", { digest })}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="button" size="sm" onClick={reset}>
          {t("retry")}
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={backHref}>{t(backLabel)}</Link>
        </Button>
      </div>
    </section>
  );
}
