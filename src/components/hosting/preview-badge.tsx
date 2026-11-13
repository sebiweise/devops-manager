import { useTranslations } from "next-intl";
import { StatusIcon } from "@/components/data/status-badge";
import { deployBadgeKind } from "@/lib/hosting-view";
import type { ShaDeployment } from "@/server/data/vercel";

/**
 * The deployment of a commit as a small badge (pull request rows, the run
 * page): the preview if there is one, else production. It links to the
 * deployment's URL when ready, else to its page on Vercel. Works in server
 * and client components.
 */
/** "Preview ✓" for a commit, linking to the preview URL (PR list, PR row, run page). */
export function PreviewBadge({
  deployments,
}: {
  deployments: ReadonlyArray<ShaDeployment>;
}) {
  const t = useTranslations("hosting");
  const preview = deployments.find((d) => d.target !== "production");
  const prod = deployments.find((d) => d.target === "production");
  const shown = preview ?? prod;
  if (!shown) return null;
  const label = t(
    shown.target === "production"
      ? "deployedAsProduction"
      : "deployedAsPreview",
    {
      state: t(`state.${deployBadgeKind(shown.state)}`),
    },
  );
  const href =
    shown.url && shown.state === "READY"
      ? `https://${shown.url}`
      : shown.vercelUrl;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`${shown.projectName} · ${label}`}
      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs whitespace-nowrap hover:bg-accent"
    >
      <StatusIcon
        kind={deployBadgeKind(shown.state)}
        className="[&>svg]:size-3"
        label={label}
      />
      <span aria-hidden="true">
        {shown.target === "production" ? t("production") : t("preview")}
      </span>
    </a>
  );
}
