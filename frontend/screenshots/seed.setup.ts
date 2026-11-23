import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { test } from "@playwright/test";

import { API_PORT, API_URL, E2E_DATABASE_URL } from "../e2e/config";

import { ADMIN, apiToken, STATE_FILE, type SeedState } from "./helpers";

/**
 * Seeds through the REST API with the project's own seed script (never raw SQL), in English,
 * with orders spread over 10 days so the sales-velocity chart has a curve.
 */
test("seed the demo promotion", async () => {
  execFileSync(
    "uv",
    ["run", "python", "scripts/seed.py", "--lang", "en", "--spread-days", "10"].concat([
      "--api-url",
      `http://localhost:${API_PORT}`,
      "--database-url",
      E2E_DATABASE_URL,
    ]),
    { cwd: path.resolve(__dirname, "../../backend"), stdio: "inherit" },
  );

  const token = await apiToken(ADMIN);
  const get = async <T>(url: string): Promise<T> => {
    const res = await fetch(`${API_URL}${url}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return (await res.json()) as T;
  };
  const promotions = await get<{ items: { id: string }[] }>("/promotions?size=100");
  const [promotion] = promotions.items;
  const orders = await get<{ items: { id: string; status_classification: string }[] }>(
    `/promotions/${promotion.id}/orders?size=100`,
  );
  // The admin GIF opens a divergence from the dashboard.
  if (!orders.items.some((o) => o.status_classification === "DIVERGENCE"))
    throw new Error("the seed should leave at least one divergence");

  // The order with the longest history (e.g. paid, delivered, then delivery revoked with a
  // reason) shows the audit trail best.
  const details = await Promise.all(
    orders.items.map((o) =>
      get<{ id: string; audit_events: unknown[] }>(`/promotions/${promotion.id}/orders/${o.id}`),
    ),
  );
  const richest = details.reduce((a, b) => (b.audit_events.length > a.audit_events.length ? b : a));

  const state: SeedState = {
    promotionId: promotion.id,
    richHistoryOrderId: richest.id,
  };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
});
