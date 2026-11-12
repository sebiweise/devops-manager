import "server-only";
import { cookies } from "next/headers";
import {
  isRange,
  RANGE_COOKIE,
  resolveRange,
  type InsightRange,
} from "./range";
import { first, type SearchParamsLike } from "./url-state";

/** The range of an insights page: `?range=`, then the cookie, then 7 days. */
export async function pageRange(sp: SearchParamsLike): Promise<InsightRange> {
  return resolveRange(
    first(sp, "range"),
    (await cookies()).get(RANGE_COOKIE)?.value,
  );
}

/** The range cookie alone (for the header control's first paint). */
export async function cookieRange(): Promise<InsightRange | null> {
  const v = (await cookies()).get(RANGE_COOKIE)?.value;
  return isRange(v) ? v : null;
}
