import Link from "next/link";
import { useTranslations } from "next-intl";
import { StatusBadge, StatusIcon } from "@/components/data/status-badge";
import { azureBadgeKind, type CiProvider } from "@/lib/azure-view";
import { cn } from "@/lib/utils";

/**
 * Small Azure Pipelines building blocks that work in server and client
 * components: the CI source badge of the merged run lists (icon-free text
 * with an accessible name, never colour alone), the build status badge
 * (partially succeeded is amber) and the pull request badge.
 */

export function SourceBadge({
  provider,
  className,
}: {
  provider: CiProvider;
  className?: string;
}) {
  const t = useTranslations("ci.source");
  return (
    <span
      aria-label={t("label", { source: t(provider) })}
      title={t(provider)}
      data-provider={provider}
      className={cn(
        "inline-flex w-fit items-center rounded border px-1.5 py-px font-mono text-[0.65rem] font-medium tracking-wide whitespace-nowrap uppercase",
        provider === "azure"
          ? "border-series-2/60 text-foreground"
          : "border-border text-muted-foreground",
        className,
      )}
    >
      {t(`short.${provider}`)}
    </span>
  );
}

export function AzureBuildBadge({
  status,
  result,
  timedOut = false,
}: {
  status: string;
  result: string | null;
  timedOut?: boolean;
}) {
  const kind = azureBadgeKind(status, result, timedOut);
  return <StatusBadge kind={kind === "partial" ? "PARTIAL" : kind} />;
}

export type PrAzureBuild = {
  id: number;
  definitionName: string;
  status: string;
  result: string;
  timedOut: boolean;
  href: string;
};

/** "Azure ✓" on a pull request row: the newest build per definition. */
export function PrAzureBadge({
  builds,
}: {
  builds: ReadonlyArray<PrAzureBuild>;
}) {
  const t = useTranslations("ci.azure.pr");
  const tb = useTranslations("badge");
  if (builds.length === 0) return null;
  return (
    <>
      {builds.slice(0, 3).map((b) => {
        const kind = azureBadgeKind(b.status, b.result, b.timedOut);
        const badge = kind === "partial" ? "PARTIAL" : kind;
        const state = tb(`${badge}.label`);
        return (
          <Link
            key={b.id}
            href={b.href}
            title={t("title", { pipeline: b.definitionName, state })}
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs whitespace-nowrap hover:bg-accent"
          >
            <StatusIcon
              kind={badge}
              className="[&>svg]:size-3"
              label={t("title", { pipeline: b.definitionName, state })}
            />
            <span aria-hidden="true">{t("short")}</span>
          </Link>
        );
      })}
    </>
  );
}
