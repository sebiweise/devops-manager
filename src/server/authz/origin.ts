/**
 * Origin check for Server Actions (design §8.1 step 1), on top of Next's
 * built-in check: the request's `Origin` must be the public base URL
 * (`BETTER_AUTH_URL`). A missing or opaque ("null") origin is refused, since
 * browsers always send one with a Server Action POST. Pure.
 */
export function originAllowed(
  origin: string | null | undefined,
  baseUrl: string,
): boolean {
  if (!origin || origin === "null") return false;
  try {
    return new URL(origin).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/** First address of a forwarded-for style header ("client, proxy1, proxy2"). */
export function firstAddress(value: string | null | undefined): string | null {
  const first = value?.split(",")[0]?.trim();
  return first ? first : null;
}
