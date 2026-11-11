import { describe, expect, it } from "vitest";
import de from "../../messages/de.json";
import en from "../../messages/en.json";

/**
 * English is the source language and complete; German must carry the same
 * keys (design §7, D6), so a missing translation never renders a raw key.
 */

function keys(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) =>
    keys(v, prefix ? `${prefix}.${k}` : k),
  );
}

function leaves(obj: unknown): unknown[] {
  if (typeof obj !== "object" || obj === null) return [obj];
  return Object.values(obj).flatMap(leaves);
}

describe("messages", () => {
  it("German has exactly the English keys", () => {
    expect(keys(de).sort()).toEqual(keys(en).sort());
  });

  it("every message is a non-empty string", () => {
    for (const v of [...leaves(en), ...leaves(de)]) {
      expect(typeof v).toBe("string");
      expect((v as string).trim()).not.toBe("");
    }
  });

  it("placeholders match between languages", () => {
    const en_ = Object.fromEntries(
      keys(en).map((k) => [
        k,
        k
          .split(".")
          .reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], en),
      ]),
    );
    const de_ = Object.fromEntries(
      keys(de).map((k) => [
        k,
        k
          .split(".")
          .reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], de),
      ]),
    );
    const vars = (s: string) =>
      [...s.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(en_))
      expect(vars(de_[k] as string), k).toEqual(vars(en_[k] as string));
  });
});

describe("messages format", () => {
  it("every message parses and formats in both languages", async () => {
    const { createTranslator } = await import("next-intl");
    for (const [locale, messages] of [
      ["en", en],
      ["de", de],
    ] as const) {
      const t = createTranslator({ locale, messages, timeZone: "UTC" });
      for (const key of keys(messages)) {
        const raw = key
          .split(".")
          .reduce<unknown>(
            (o, p) => (o as Record<string, unknown>)[p],
            messages,
          ) as string;
        const values = Object.fromEntries(
          [...raw.matchAll(/\{(\w+)[,}]/g)].map((m) => [m[1]!, 2]),
        );
        const out = (t as unknown as (k: string, v: object) => string)(
          key,
          values,
        );
        expect(out, `${locale}:${key}`).not.toContain(key);
      }
    }
  });
});
