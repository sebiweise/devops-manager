export const LOCALES = ["en", "de"] as const;
export type Locale = (typeof LOCALES)[number];

/** Cookie holding the chosen UI language (no locale prefix in URLs). */
export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" && (LOCALES as readonly string[]).includes(value)
  );
}

export function defaultLocale(): Locale {
  const configured = process.env.DEFAULT_LOCALE;
  return isLocale(configured) ? configured : "en";
}
