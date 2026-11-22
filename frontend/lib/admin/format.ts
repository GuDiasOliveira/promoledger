import { parseMoney } from "@/lib/money";

/** Share of `part` in `total` in basis points (0..10000), exact integer math on cents. */
export function shareBasisPoints(part: string, total: string): number {
  const t = parseMoney(total);
  if (t === 0n) return 0;
  return Number((parseMoney(part) * 10000n) / t);
}

/**
 * The API sends percentages as exact decimal strings ("98.52"). Format them per locale
 * without floats: "98.52" -> Intl receives the exact string "0.9852".
 */
export function formatPercent(percentage: string, locale: string): string {
  const basisPoints = parseMoney(percentage); // "98.52" -> 9852n (two decimals)
  const whole = basisPoints / 10000n;
  const fraction = (basisPoints % 10000n).toString().padStart(4, "0");
  return new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 2 }).format(
    `${whole}.${fraction}` as Intl.StringNumericLiteral,
  );
}
