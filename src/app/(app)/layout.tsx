import { Activity } from "lucide-react";
import Link from "next/link";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { AccountSwitcher } from "@/components/shell/account-switcher";
import { AdminMenu, UserMenu } from "@/components/shell/user-menu";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";
import { hasRole } from "@/server/authz/roles";
import { requireScope } from "@/server/better-auth/session";
import { listInstallations } from "@/server/data/installations";

/**
 * The app header (UI overhaul §1.1): the logo links to the start page, the
 * account switcher names where you are, the Admin menu (admins) holds the
 * instance pages, and the user menu holds language, theme, settings and
 * sign out.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, scope } = await requireScope();
  const [t, installations, jar] = await Promise.all([
    getTranslations(),
    listInstallations(scope),
    cookies(),
  ]);
  const isAdmin = hasRole(scope.role, "ADMIN");

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <nav
          className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 text-sm sm:gap-4 sm:px-6"
          aria-label={t("shell.mainNav")}
        >
          <Link
            href="/dashboard"
            className="flex shrink-0 items-center gap-2 rounded-md font-semibold focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Activity aria-hidden="true" className="size-5 text-series-1" />
            <span className="hidden sm:inline">{t("common.appName")}</span>
            <span className="sr-only sm:hidden">{t("common.appName")}</span>
          </Link>
          <span aria-hidden="true" className="text-muted-foreground">
            /
          </span>
          <AccountSwitcher
            accounts={installations.map((i) => ({
              login: i.accountLogin,
              type: i.accountType,
            }))}
          />
          <div className="ml-auto flex items-center gap-1">
            {isAdmin ? (
              <AdminMenu
                items={[
                  { href: "/onboarding", label: t("nav.onboarding") },
                  { href: "/admin/github", label: t("nav.github") },
                ]}
              />
            ) : null}
            <UserMenu
              email={user.email}
              role={t(`settings.roles.${scope.role}`)}
              theme={parseTheme(jar.get(THEME_COOKIE)?.value)}
            />
          </div>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}
