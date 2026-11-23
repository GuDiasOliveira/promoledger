/**
 * Form parsing for admin screens. Pure and unit-tested.
 */

export type MoneyInputResult =
  | { ok: true; value: string } // exact API decimal string, e.g. "19.90"
  | { ok: false; reason: "format" | "decimals" | "range" | "positive" };

/**
 * Accept what people type worldwide: "19,90" or "19.90" (one decimal separator, up to
 * 2 decimals). Thousands separators are REJECTED: "1.234,50" or "1,234.50" are ambiguous
 * across locales, and guessing could store a price 1000× off. No floats involved.
 */
export function parseMoneyInput(raw: string): MoneyInputResult {
  const text = raw.trim();
  const match = /^(\d+)(?:[.,](\d*))?$/.exec(text);
  if (!match) return { ok: false, reason: "format" };
  const [, whole, fraction = ""] = match;
  if (fraction.length > 2) return { ok: false, reason: "decimals" };
  const digits = whole.replace(/^0+(?=\d)/, "");
  if (digits.length > 8) return { ok: false, reason: "range" }; // NUMERIC(10, 2)
  const value = `${digits}.${fraction.padEnd(2, "0")}`;
  if (/^0\.00$/.test(value)) return { ok: false, reason: "positive" };
  return { ok: true, value };
}

/** Inverse for editing: "19.90" -> "19,90" in locales that use a decimal comma. */
export function moneyToInput(value: string, locale: string): string {
  const decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal")?.value;
  return decimal === "," ? value.replace(".", ",") : value;
}

/** Same rule as the backend (docs/erm.md §2.2): start <= last sales <= delivery. */
export function validDateRange(start: string, lastSales: string, delivery: string): boolean {
  // ISO dates (YYYY-MM-DD) compare correctly as strings.
  return Boolean(start && lastSales && delivery) && start <= lastSales && lastSales <= delivery;
}
