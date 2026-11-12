"use client";

import { Building2, ChevronsUpDown, LayoutGrid, User } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { HeaderMenu, MenuLabel, MenuLink, MenuSeparator } from "./menu";

export type SwitcherAccount = {
  login: string;
  type: "USER" | "ORGANIZATION";
};

/** The login of the `/o/[account]` route, if the page is inside one. */
export function accountOfPath(pathname: string): string | null {
  const m = /^\/o\/([^/]+)/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/**
 * The account switcher of the app header (UI overhaul §1.1): shows the
 * current organisation or user account with its type, lists "All accounts"
 * (the start page) and every visible installation. A filter field appears
 * once there are more than eight accounts.
 */
export function AccountSwitcher({
  accounts,
}: {
  accounts: ReadonlyArray<SwitcherAccount>;
}) {
  const t = useTranslations("shell");
  const pathname = usePathname();
  const current = accountOfPath(pathname);
  const currentAccount = accounts.find((a) => a.login === current) ?? null;
  const [q, setQ] = useState("");
  const filterId = useId();
  const shown = accounts.filter((a) =>
    a.login.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const Icon = (a: SwitcherAccount) =>
    a.type === "ORGANIZATION" ? (
      <Building2 aria-hidden="true" className="size-4 text-muted-foreground" />
    ) : (
      <User aria-hidden="true" className="size-4 text-muted-foreground" />
    );

  return (
    <HeaderMenu
      align="left"
      label={t("switcher.label", {
        current: currentAccount?.login ?? t("switcher.all"),
      })}
      trigger={
        <>
          {currentAccount ? (
            Icon(currentAccount)
          ) : (
            <LayoutGrid
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
          )}
          <span className="max-w-36 truncate font-medium sm:max-w-56">
            {currentAccount?.login ?? t("switcher.all")}
          </span>
          {/* The account header below names the type; the icon is enough here. */}
          <ChevronsUpDown
            aria-hidden="true"
            className="size-3.5 text-muted-foreground"
          />
        </>
      }
    >
      <MenuLink href="/dashboard" current={pathname === "/dashboard"}>
        <LayoutGrid
          aria-hidden="true"
          className="size-4 text-muted-foreground"
        />
        {t("switcher.all")}
      </MenuLink>
      <MenuSeparator />
      <MenuLabel>{t("switcher.accounts")}</MenuLabel>
      {accounts.length > 8 ? (
        <div className="px-1 pb-1">
          <label htmlFor={filterId} className="sr-only">
            {t("switcher.filter")}
          </label>
          <input
            id={filterId}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("switcher.filter")}
            className="h-8 w-full rounded-md border bg-background px-2 text-sm"
          />
        </div>
      ) : null}
      <div className="max-h-72 overflow-y-auto">
        {shown.map((a) => (
          <MenuLink
            key={a.login}
            href={`/o/${encodeURIComponent(a.login)}`}
            current={a.login === current}
          >
            {Icon(a)}
            <span className="min-w-0 flex-1 truncate">{a.login}</span>
            <span className="text-xs text-muted-foreground">
              {a.type === "ORGANIZATION"
                ? t("type.ORGANIZATION")
                : t("type.USER")}
            </span>
          </MenuLink>
        ))}
        {shown.length === 0 ? (
          <p className="px-2 py-1.5 text-muted-foreground">
            {t("switcher.none")}
          </p>
        ) : null}
      </div>
    </HeaderMenu>
  );
}
