import { describe, expect, it } from "vitest";

import { orderFiltersQuery, orderFiltersToApi, parseOrderFilters, totalPages } from "./filters";
import { formatPercent, shareBasisPoints } from "./format";

const PROMO = "11111111-1111-4111-8111-111111111111";
const SELLER = "22222222-2222-4222-8222-222222222222";
const plain = (s: string) => s.replace(/[  ]/g, " ");

describe("order filters in the URL", () => {
  it("round-trips through the query string", () => {
    const filters = { classification: "DIVERGENCE" as const, sellerMemberId: SELLER, customerId: null, page: 3 };
    const query = orderFiltersQuery(PROMO, filters);
    expect(query).toBe(`id=${PROMO}&status=DIVERGENCE&seller=${SELLER}&page=3`);
    expect(parseOrderFilters(new URLSearchParams(query))).toEqual(filters);
  });

  it("ignores invalid or hostile values instead of sending them to the API", () => {
    const parsed = parseOrderFilters(
      new URLSearchParams("status=DROP_TABLE&seller=not-a-uuid&customer=1&page=-4"),
    );
    expect(parsed).toEqual({ classification: null, sellerMemberId: null, customerId: null, page: 1 });
  });

  it("maps to the API query (omitting empty filters)", () => {
    expect(orderFiltersToApi({ classification: null, sellerMemberId: SELLER, customerId: null, page: 2 }, 20)).toEqual({
      page: 2,
      size: 20,
      seller_member_id: SELLER,
    });
  });

  it.each([[0, 1], [20, 1], [21, 2], [100, 5]])("totalPages(%i) = %i", (total, pages) => {
    expect(totalPages(total, 20)).toBe(pages);
  });
});

describe("exact display math", () => {
  it("computes shares in basis points from money strings", () => {
    expect(shareBasisPoints("19.90", "79.90")).toBe(2490); // 24.90%
    expect(shareBasisPoints("0.00", "0.00")).toBe(0);
    expect(shareBasisPoints("79.90", "79.90")).toBe(10000);
  });

  it.each([
    ["98.52", "en-US", "98.52%"],
    ["98.52", "pt-BR", "98,52%"],
    ["0.00", "es-ES", "0,00 %"],
    ["100.00", "en-US", "100.00%"],
  ])("formatPercent(%s, %s) = %s", (value, locale, expected) => {
    expect(plain(formatPercent(value, locale))).toBe(expected);
  });
});
