import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { APP_SHELL } from "./shell";

/** All `page.tsx` routes under app/, as URL paths. */
function pageRoutes(dir: string, base = ""): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return pageRoutes(full, `${base}/${entry}`);
    return entry === "page.tsx" ? [base || "/"] : [];
  });
}

describe("APP_SHELL", () => {
  it("lists exactly the app's pages (so every screen can open offline)", () => {
    const routes = pageRoutes(path.resolve(import.meta.dirname, "../../app")).sort();
    expect([...APP_SHELL].sort()).toEqual(routes);
  });

  it("has no dynamic segments (those cannot be pre-cached once for all ids)", () => {
    expect(APP_SHELL.some((route) => route.includes("["))).toBe(false);
  });
});
