import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LanguageSwitch } from "@/components/language-switch";
import { SignOutButton } from "@/components/sign-out-button";
import { hasRole } from "@/server/authz/roles";
import { requireScope } from "@/server/better-auth/session";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { scope } = await requireScope();
  const t = await getTranslations();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <nav
          className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3 text-sm"
          aria-label="Main"
        >
          <Link href="/dashboard" className="font-semibold">
            {t("common.appName")}
          </Link>
          <Link href="/dashboard">{t("nav.dashboard")}</Link>
          {hasRole(scope.role, "ADMIN") ? (
            <>
              <Link href="/onboarding">{t("nav.onboarding")}</Link>
              <Link href="/admin/github">{t("nav.github")}</Link>
            </>
          ) : null}
          <Link href="/settings">{t("nav.settings")}</Link>
          <div className="ml-auto flex items-center gap-3">
            <LanguageSwitch />
            <SignOutButton label={t("common.signOut")} />
          </div>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        {children}
      </main>
    </div>
  );
}
