import { type Locale, loadStoredLocale, matchLocale, storeLocale } from "./config";

/** Client-side locale store (explicit choice > browser languages), for useSyncExternalStore. */

const listeners = new Set<() => void>();
let current: Locale | null = null;

export function getLocale(): Locale {
  current ??= loadStoredLocale() ?? matchLocale(navigator.languages ?? [navigator.language]);
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
  storeLocale(locale);
  for (const listener of listeners) listener();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
