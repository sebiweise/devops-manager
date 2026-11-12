import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { SignOutButton } from "@/components/sign-out-button";
import { PageHeader } from "@/components/shell/page-header";
import { LanguageSelect, ThemeSelect } from "@/components/shell/user-menu";
import { pageTitle } from "@/lib/page-meta";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import { requireScope } from "@/server/better-auth/session";

export async function generateMetadata() {
  return pageTitle("userSettings");
}

/** User settings (UI overhaul §2.15): profile and role, language, theme. */
export default async function SettingsPage() {
  const { user, scope } = await requireScope();
  const [t, jar] = await Promise.all([getTranslations(), cookies()]);
  const theme = parseTheme(jar.get(THEME_COOKIE)?.value);

  const row = "flex flex-wrap items-center justify-between gap-3 py-4";
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <PageHeader title={t("settings.title")} />
      <div className="divide-y rounded-xl border bg-card px-4">
        <section aria-labelledby="profile" className={row}>
          <div className="flex flex-col gap-0.5">
            <h2 id="profile" className="font-medium">
              {t("settings.profile")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("settings.signedInAs", { email: user.email })}
            </p>
          </div>
          <span className="rounded-full border px-2.5 py-0.5 text-sm">
            {t("settings.roleIs", { role: t(`settings.roles.${scope.role}`) })}
          </span>
        </section>
        <section className={row}>
          <label htmlFor="settings-language" className="font-medium">
            {t("common.language")}
          </label>
          <LanguageSelect id="settings-language" />
        </section>
        <section className={row}>
          <div className="flex flex-col gap-0.5">
            <label htmlFor="settings-theme" className="font-medium">
              {t("shell.theme.label")}
            </label>
            <p className="text-sm text-muted-foreground">
              {t("settings.themeHint")}
            </p>
          </div>
          <ThemeSelect id="settings-theme" theme={theme} />
        </section>
        <section className={row}>
          <p className="text-sm text-muted-foreground">
            {t("settings.signOutHint")}
          </p>
          <SignOutButton label={t("common.signOut")} />
        </section>
      </div>
    </div>
  );
}
