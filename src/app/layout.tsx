import type { Metadata } from "next";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { parseTheme, THEME_COOKIE, themeClass } from "@/lib/theme";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: { default: "DevOps Manager", template: "%s · DevOps Manager" },
  description: "GitHub Actions insights and management through a GitHub App",
  robots: { index: false, follow: false },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [locale, jar] = await Promise.all([getLocale(), cookies()]);
  const theme = parseTheme(jar.get(THEME_COOKIE)?.value);
  return (
    <html lang={locale} className={themeClass(theme)}>
      <body className="min-h-dvh antialiased">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
