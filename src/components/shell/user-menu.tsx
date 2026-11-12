"use client";

import { CircleUser, LogOut, Settings, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useId, useTransition } from "react";
import { setLocale, setTheme } from "@/i18n/actions";
import { LOCALES } from "@/i18n/config";
import { authClient } from "@/lib/auth-client";
import { THEMES, type Theme } from "@/lib/theme";
import { HeaderMenu, MenuLabel, MenuLink, MenuSeparator } from "./menu";

/** Language select; changes the cookie and re-renders the page. */
export function LanguageSelect({ id }: { id?: string }) {
  const t = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <select
      id={id}
      className="h-8 rounded-md border bg-background px-2 text-sm"
      value={locale}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value;
        startTransition(async () => {
          await setLocale(next);
          router.refresh();
        });
      }}
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {t(`languages.${l}`)}
        </option>
      ))}
    </select>
  );
}

/** Theme select (System / Light / Dark); the server sets the class. */
export function ThemeSelect({ id, theme }: { id?: string; theme: Theme }) {
  const t = useTranslations("shell.theme");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <select
      id={id}
      className="h-8 rounded-md border bg-background px-2 text-sm"
      value={theme}
      disabled={pending}
      onChange={(e) => {
        const next = e.target.value;
        // Apply at once, then let the server confirm on refresh.
        const root = document.documentElement;
        root.classList.remove("light", "dark");
        if (next !== "system") root.classList.add(next);
        startTransition(async () => {
          await setTheme(next);
          router.refresh();
        });
      }}
    >
      {THEMES.map((th) => (
        <option key={th} value={th}>
          {t(th)}
        </option>
      ))}
    </select>
  );
}

export function SignOutMenuButton() {
  const t = useTranslations("common");
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await authClient.signOut();
        router.push("/login");
      }}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <LogOut aria-hidden="true" className="size-4 text-muted-foreground" />
      {t("signOut")}
    </button>
  );
}

/** The user menu: who is signed in, role, language, theme, settings, sign out. */
export function UserMenu({
  email,
  role,
  theme,
}: {
  email: string;
  /** Localized role name. */
  role: string;
  theme: Theme;
}) {
  const t = useTranslations("shell");
  const langId = useId();
  const themeId = useId();
  return (
    <HeaderMenu
      label={t("userMenu", { email })}
      trigger={
        <CircleUser aria-hidden="true" className="size-5 text-foreground" />
      }
      panelClassName="w-72"
    >
      <div className="flex flex-col gap-0.5 px-2 py-1.5">
        <span className="truncate font-medium">{email}</span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <ShieldCheck aria-hidden="true" className="size-3.5" />
          {role}
        </span>
      </div>
      <MenuSeparator />
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 px-2 py-1.5">
        <label htmlFor={langId} className="text-muted-foreground">
          {t("language")}
        </label>
        <LanguageSelect id={langId} />
        <label htmlFor={themeId} className="text-muted-foreground">
          {t("theme.label")}
        </label>
        <ThemeSelect id={themeId} theme={theme} />
      </div>
      <MenuSeparator />
      <MenuLink href="/settings">
        <Settings aria-hidden="true" className="size-4 text-muted-foreground" />
        {t("userSettings")}
      </MenuLink>
      <SignOutMenuButton />
    </HeaderMenu>
  );
}

/** The Admin menu (admins only). */
export function AdminMenu({
  items,
}: {
  items: ReadonlyArray<{ href: string; label: string }>;
}) {
  const t = useTranslations("shell");
  return (
    <HeaderMenu
      label={t("admin")}
      trigger={
        <>
          <ShieldCheck aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">{t("admin")}</span>
        </>
      }
    >
      <MenuLabel>{t("admin")}</MenuLabel>
      {items.map((i) => (
        <MenuLink key={i.href} href={i.href}>
          {i.label}
        </MenuLink>
      ))}
    </HeaderMenu>
  );
}
