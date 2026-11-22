import enUS from "@/messages/en-US.json";
import esES from "@/messages/es-ES.json";
import ptBR from "@/messages/pt-BR.json";

export const locales = ["en-US", "pt-BR", "es-ES"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en-US";

export const messages: Record<Locale, typeof enUS> = {
  "en-US": enUS,
  "pt-BR": ptBR,
  "es-ES": esES,
};

/** Native names, so each option is readable by its own speakers. */
export const localeLabels: Record<Locale, string> = {
  "en-US": "English (US)",
  "pt-BR": "Português (Brasil)",
  "es-ES": "Español (España)",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

/**
 * Pick the best supported locale for the browser's preference list
 * (`navigator.languages`, the same source as the Accept-Language header):
 * exact tag first ("pt-BR"), then same language ("pt-PT" -> "pt-BR").
 */
export function matchLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const exact = locales.find((l) => l.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const language = tag.split("-")[0]?.toLowerCase();
    const sameLanguage = locales.find((l) => l.split("-")[0].toLowerCase() === language);
    if (sameLanguage) return sameLanguage;
  }
  return defaultLocale;
}

const STORAGE_KEY = "promoledger.locale";

export function loadStoredLocale(): Locale | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Storage unavailable (private mode, blocked): the choice just won't persist.
  }
}
