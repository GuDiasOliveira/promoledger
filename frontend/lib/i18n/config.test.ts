import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { defaultLocale, locales, matchLocale, messages } from "./config";

function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keyPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

/** Argument names: simple `{name}` and ICU `{count, plural, ...}` (but not `{# item}`). */
function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]))].sort();
}

describe("message catalogs", () => {
  const reference = keyPaths(messages[defaultLocale]).sort();

  it.each(locales)("%s has exactly the same keys as en-US", (locale) => {
    expect(keyPaths(messages[locale]).sort()).toEqual(reference);
  });

  it.each(locales)("%s has no empty translations", (locale) => {
    const flat = keyPaths(messages[locale]).map((path) =>
      path
        .split(".")
        .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], messages[locale]),
    );
    expect(flat.every((text) => typeof text === "string" && text.trim().length > 0)).toBe(true);
  });

  it.each(locales)("%s keeps the same {placeholders} as en-US", (locale) => {
    for (const path of reference) {
      const get = (catalog: unknown) =>
        path
          .split(".")
          .reduce<unknown>(
            (node, key) => (node as Record<string, unknown>)[key],
            catalog,
          ) as string;
      expect(placeholders(get(messages[locale])), `${locale}:${path}`).toEqual(
        placeholders(get(messages[defaultLocale])),
      );
    }
  });
});

describe("matchLocale", () => {
  it.each([
    [["pt-BR"], "pt-BR"],
    [["pt-PT"], "pt-BR"], // same language
    [["es"], "es-ES"],
    [["es-MX", "en"], "es-ES"],
    [["en-GB"], "en-US"],
    [["de-DE", "fr-FR"], "en-US"], // unsupported -> default
    [["de-DE", "pt"], "pt-BR"], // first supported preference wins
    [[], "en-US"],
  ])("%j -> %s", (preferred, expected) => {
    expect(matchLocale(preferred)).toBe(expected);
  });
});

describe("plural rules per locale (CLDR)", () => {
  const count = (locale: (typeof locales)[number], n: number) =>
    createTranslator({ locale, messages: messages[locale] })("admin.count", { count: n });

  // In pt-BR the CLDR "one" category covers 0 AND 1, unlike English: "0 pedido" is wrong.
  it.each([
    ["en-US", 0, "0 orders"],
    ["en-US", 1, "1 order"],
    ["pt-BR", 0, "0 pedidos"],
    ["pt-BR", 1, "1 pedido"],
    ["pt-BR", 2, "2 pedidos"],
    ["es-ES", 0, "0 pedidos"],
    ["es-ES", 1, "1 pedido"],
  ] as const)("%s %i -> %s", (locale, n, expected) => {
    expect(count(locale, n)).toBe(expected);
  });
});
