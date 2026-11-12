import Link from "next/link";
import { useTranslations } from "next-intl";

/**
 * Shown on the management pages while actions are unavailable (design
 * §8.1 gates): the global kill switch MANAGEMENT_ENABLED=false, or the
 * installation's own toggle being off. Read-only views stay usable.
 */
export function ManagementBanner({
  state,
  settingsHref,
}: {
  state: { globalEnabled: boolean; installationEnabled: boolean };
  /** Link to the installation settings (admins only). */
  settingsHref?: string;
}) {
  const t = useTranslations("management");
  if (state.globalEnabled && state.installationEnabled) return null;
  return (
    <section
      aria-label={t("banner.label")}
      className="rounded-xl border border-amber-500/50 bg-amber-500/5 p-3 text-sm"
    >
      <p className="font-medium">
        {!state.globalEnabled ? t("disabledGlobal") : t("disabledInstallation")}
      </p>
      <p className="text-muted-foreground">
        {!state.globalEnabled ? t("banner.globalHint") : t("banner.readOnly")}
        {state.globalEnabled && settingsHref ? (
          <>
            {" "}
            <Link className="underline" href={settingsHref}>
              {t("banner.openSettings")}
            </Link>
          </>
        ) : null}
      </p>
    </section>
  );
}
