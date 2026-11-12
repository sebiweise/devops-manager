import { CircleCheck, CircleDashed } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

/**
 * What a new account is waiting for (UI overhaul §1.9), instead of an empty
 * chart: (1) App installed, (2) history import progress (from the sync
 * health backfill progress), (3) first webhook received. Admins get the
 * "Settings & sync" link.
 */
export function GettingStarted({
  importProgress,
  webhookReceived,
  settingsHref,
}: {
  /** 0..1 over all repositories; null when nothing is imported yet. */
  importProgress: number | null;
  webhookReceived: boolean;
  settingsHref?: string;
}) {
  const t = useTranslations("gettingStarted");
  const format = useFormatter();
  const pct = Math.round(Math.min(1, Math.max(0, importProgress ?? 0)) * 100);
  const steps = [
    { key: "installed", done: true },
    { key: "import", done: pct >= 100 },
    { key: "webhook", done: webhookReceived },
  ] as const;
  return (
    <section
      aria-labelledby="getting-started"
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <h2 id="getting-started" className="font-medium">
        {t("title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("waiting")}</p>
      <ol className="flex flex-col gap-2 text-sm">
        {steps.map((s) => (
          <li key={s.key} className="flex flex-col gap-1">
            <span className="flex items-center gap-2">
              {s.done ? (
                <CircleCheck
                  aria-hidden="true"
                  className="size-4 text-status-good"
                />
              ) : (
                <CircleDashed
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
              )}
              <span>{t(`steps.${s.key}`)}</span>
              <span className="sr-only">
                {s.done ? t("done") : t("pending")}
              </span>
              {s.key === "import" ? (
                <span className="text-muted-foreground tabular-nums">
                  {format.number(pct / 100, { style: "percent" })}
                </span>
              ) : null}
            </span>
            {s.key === "import" ? (
              <span
                role="meter"
                aria-label={t("steps.import")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                className="ml-6 block h-1.5 w-48 overflow-hidden rounded-full bg-seq-1/40"
              >
                <span
                  className="block h-full rounded-full bg-seq-3"
                  style={{ width: `${pct}%` }}
                />
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      {settingsHref ? (
        <Link
          href={settingsHref}
          className="w-fit text-sm underline-offset-2 hover:underline"
        >
          {t("settings")}
        </Link>
      ) : null}
    </section>
  );
}
