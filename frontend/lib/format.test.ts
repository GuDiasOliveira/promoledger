import { describe, expect, it } from "vitest";

import { formatDate } from "./format";

describe("formatDate", () => {
  it.each([
    ["en-US", "Mar 30, 2026"],
    ["pt-BR", "30 de mar. de 2026"],
    ["es-ES", "30 mar 2026"],
  ])("formats calendar dates per locale (%s)", (locale, expected) => {
    expect(formatDate("2026-03-30", locale)).toBe(expected);
  });

  it("never shifts the day for viewers west of UTC", () => {
    // Formatting in UTC: a date-only value must not become Mar 29 in the Americas.
    expect(formatDate("2026-03-01", "en-US")).toBe("Mar 1, 2026");
  });
});
