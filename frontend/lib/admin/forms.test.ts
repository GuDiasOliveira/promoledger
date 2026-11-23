import { describe, expect, it } from "vitest";

import { moneyToInput, parseMoneyInput, validDateRange } from "./forms";

describe("parseMoneyInput", () => {
  it.each([
    ["19,90", "19.90"],
    ["19.90", "19.90"],
    ["19.9", "19.90"],
    ["0,5", "0.50"],
    ["19", "19.00"],
    ["19,", "19.00"],
    [" 7,25 ", "7.25"],
    ["007.10", "7.10"],
    ["99999999,99", "99999999.99"],
  ])("%j -> %s", (raw, value) => {
    expect(parseMoneyInput(raw)).toEqual({ ok: true, value });
  });

  it.each([
    ["1.234,50", "format"], // thousands separator: ambiguous, rejected
    ["1,234.50", "format"],
    ["-1", "format"],
    ["abc", "format"],
    ["", "format"],
    ["1e3", "format"],
    ["19,999", "decimals"],
    ["100000000", "range"],
    ["0", "positive"],
    ["0,00", "positive"],
  ])("%j is rejected (%s)", (raw, reason) => {
    expect(parseMoneyInput(raw)).toEqual({ ok: false, reason });
  });
});

describe("moneyToInput", () => {
  it.each([
    ["19.90", "pt-BR", "19,90"],
    ["19.90", "es-ES", "19,90"],
    ["19.90", "en-US", "19.90"],
  ])("%s in %s -> %s", (value, locale, expected) => {
    expect(moneyToInput(value, locale)).toBe(expected);
  });
});

describe("validDateRange", () => {
  it("accepts start <= last <= delivery (equal dates allowed)", () => {
    expect(validDateRange("2026-03-01", "2026-03-25", "2026-03-30")).toBe(true);
    expect(validDateRange("2026-03-01", "2026-03-01", "2026-03-01")).toBe(true);
  });

  it.each([
    ["2026-03-10", "2026-03-01", "2026-03-30"],
    ["2026-03-01", "2026-03-25", "2026-03-20"],
    ["", "2026-03-25", "2026-03-30"],
  ])("rejects %s / %s / %s", (a, b, c) => {
    expect(validDateRange(a, b, c)).toBe(false);
  });
});
