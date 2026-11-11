/**
 * Accepts only same-origin relative paths as post-login targets, so `?next=`
 * cannot send a user to another site.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null;
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\")
  )
    return null;
  if (/[\u0000-\u001f]/.test(value)) return null;
  try {
    const url = new URL(value, "http://localhost");
    if (url.origin !== "http://localhost") return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
