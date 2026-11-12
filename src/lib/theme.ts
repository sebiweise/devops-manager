/**
 * The colour theme preference (UI overhaul §2.15): "system" follows the
 * operating system (prefers-color-scheme), "light" and "dark" force one.
 * Stored in the `theme` cookie; the root layout sets the matching class on
 * <html> on the server, so the first paint has the right colours.
 */

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_COOKIE = "theme";

export function isTheme(value: unknown): value is Theme {
  return (
    typeof value === "string" && (THEMES as readonly string[]).includes(value)
  );
}

export function parseTheme(value: string | null | undefined): Theme {
  return isTheme(value) ? value : "system";
}

/** The class on <html>: none for "system" (CSS media query decides). */
export function themeClass(theme: Theme): string | undefined {
  return theme === "system" ? undefined : theme;
}
