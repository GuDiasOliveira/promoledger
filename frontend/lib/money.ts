/**
 * Exact money handling (CLAUDE.md §2, docs/api.md §1.2).
 *
 * The API sends amounts as decimal strings ("19.90"). Here they become integer cents
 * as `bigint` and are never converted to `number`, so no binary floating point is
 * ever involved in arithmetic or display.
 */

const MONEY_RE = /^(\d{1,15})(?:\.(\d{1,2}))?$/;

/** "19.9" | "19.90" -> 1990n. Throws on anything that is not a plain non-negative decimal. */
export function parseMoney(value: string): bigint {
  const match = MONEY_RE.exec(value);
  if (!match) throw new Error(`Invalid money string: ${JSON.stringify(value)}`);
  const [, whole, fraction = ""] = match;
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

/** 1990n -> "19.90" (the API wire format). */
export function toDecimalString(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${sign}${abs / 100n}.${fraction}`;
}

export function lineTotal(unitCents: bigint, quantity: number): bigint {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new Error(`Invalid quantity: ${quantity}`);
  }
  return unitCents * BigInt(quantity);
}

export function sumMoney(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

/**
 * Locale-aware display, e.g. (1990n, "BRL", "pt-BR") -> "R$ 19,90".
 * Intl receives the exact decimal *string*, so precision is never lost.
 */
export function formatMoney(cents: bigint, currency: string, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency });
  return formatter.format(toDecimalString(cents) as Intl.StringNumericLiteral);
}
