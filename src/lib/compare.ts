/**
 * Orders strings by UTF-16 code units, exactly like `Array#sort()` without a
 * compare function, but explicit. Used where the order must be stable and
 * locale-independent (canonical URLs, ISO dates, label keys).
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
