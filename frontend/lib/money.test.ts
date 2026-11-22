import { describe, expect, it } from "vitest";

import { formatMoney, lineTotal, parseMoney, sumMoney, toDecimalString } from "./money";

// Intl uses (narrow) no-break spaces; normalize them for readable assertions.
const plain = (s: string) => s.replace(/[  ]/g, " ");

describe("parseMoney / toDecimalString", () => {
  it.each([
    ["19.90", 1990n],
    ["19.9", 1990n],
    ["19", 1900n],
    ["0.01", 1n],
    ["99999999.99", 9999999999n],
  ])("parses %s exactly", (input, cents) => {
    expect(parseMoney(input)).toBe(cents);
  });

  it.each(["", "19.999", "-1.00", "1e3", "19,90", " 19.90", "abc", "0x10"])(
    "rejects %j",
    (input) => {
      expect(() => parseMoney(input)).toThrow();
    },
  );

  it("round-trips to the API wire format", () => {
    expect(toDecimalString(parseMoney("19.9"))).toBe("19.90");
    expect(toDecimalString(5n)).toBe("0.05");
    expect(toDecimalString(-150n)).toBe("-1.50");
  });
});

describe("arithmetic is exact (no floating point)", () => {
  it("0.10 × 3 is exactly 0.30", () => {
    // With numbers: 0.1 * 3 === 0.30000000000000004
    expect(toDecimalString(lineTotal(parseMoney("0.10"), 3))).toBe("0.30");
  });

  it("sums many small amounts exactly", () => {
    const tenCents = Array.from({ length: 1000 }, () => parseMoney("0.10"));
    expect(toDecimalString(sumMoney(tenCents))).toBe("100.00");
  });

  it("rejects non-integer quantities", () => {
    expect(() => lineTotal(100n, 1.5)).toThrow();
    expect(() => lineTotal(100n, -1)).toThrow();
  });
});

describe("formatMoney uses the promotion currency and the viewer locale", () => {
  it.each([
    [1990n, "USD", "en-US", "$19.90"],
    [1990n, "BRL", "pt-BR", "R$ 19,90"],
    [1990n, "USD", "pt-BR", "US$ 19,90"],
    [1990n, "EUR", "es-ES", "19,90 €"],
    [123456789n, "EUR", "en-US", "€1,234,567.89"],
  ])("%s %s in %s -> %s", (cents, currency, locale, expected) => {
    expect(plain(formatMoney(cents, currency, locale))).toBe(expected);
  });

  it("keeps precision beyond what a float can represent", () => {
    // 2^53 + 1 cents cannot be represented exactly as a JS number.
    const huge = 9007199254740993n;
    expect(plain(formatMoney(huge, "USD", "en-US"))).toBe("$90,071,992,547,409.93");
  });
});
