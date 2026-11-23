import { expect, test } from "@playwright/test";

import { API_PORT } from "../e2e/config";

import { ADMIN, GifRecorder, logIn, readState, shot, showClicks } from "./helpers";

// The admin's side: a desktop tool, online-only.

test("admin screens", async ({ page }) => {
  const { promotionId, richHistoryOrderId } = readState();
  await logIn(page, ADMIN);

  await page.goto(`/promotion/admin?id=${promotionId}`);
  await expect(page.getByTestId("kpi-revenue")).toBeVisible();
  await expect(page.getByTestId("leaderboard")).toBeVisible();
  await shot(page, "admin-dashboard", { fullPage: true });

  await page.goto(`/promotion/admin/orders?id=${promotionId}`);
  await expect(page.getByTestId("admin-orders")).toBeVisible();
  await shot(page, "admin-orders");

  await page.goto(`/promotion/admin/order?id=${promotionId}&order=${richHistoryOrderId}`);
  await expect(page.getByTestId("history")).toBeVisible();
  await shot(page, "admin-order-detail");

  await page.goto(`/promotion/admin/audit?id=${promotionId}`);
  await expect(page.getByTestId("audit")).toBeVisible();
  await shot(page, "admin-audit-trail");

  await page.goto(`/promotion/admin/products?id=${promotionId}`);
  await expect(page.getByTestId("product-row").first()).toBeVisible();
  await shot(page, "admin-products");

  await page.goto(`/promotion/admin/members?id=${promotionId}`);
  await expect(page.getByTestId("member-row").first()).toBeVisible();
  await shot(page, "admin-members");

  await page.goto("/account/tokens");
  await expect(page.getByTestId("token-row").first()).toBeVisible();
  await shot(page, "api-tokens");
});

test("API docs (OpenAPI / Swagger UI)", async ({ page }) => {
  await page.goto(`http://localhost:${API_PORT}/docs`);
  const createOrder = page.locator(
    "#operations-orders-create_order_api_v1_promotions__promotion_id__orders_post",
  );
  await createOrder.locator(".opblock-summary").click();
  await expect(createOrder.getByText("idempotency-key", { exact: false }).first()).toBeVisible();
  await createOrder.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -120));
  await shot(page, "api-docs-swagger");

  await page.goto(`http://localhost:${API_PORT}/docs`);
  await expect(page.locator(".opblock").first()).toBeVisible();
  await shot(page, "api-docs-overview");
});

test("GIF: admin resolves a divergence and the dashboard follows", async ({ page }) => {
  const { promotionId } = readState();
  await logIn(page, ADMIN);
  await page.goto(`/promotion/admin?id=${promotionId}`);
  await expect(page.getByTestId("kpi-revenue")).toBeVisible();
  await showClicks(page);

  const gif = new GifRecorder(page, "admin-divergence", 960);
  await gif.start();
  await gif.hold(1500);
  await page.getByTestId("divergences").scrollIntoViewIfNeeded();
  await gif.hold(1200);
  await page.getByTestId("divergences").getByRole("link").first().click();
  await expect(page.getByTestId("admin-order-status")).toHaveText("Delivered · unpaid");
  await showClicks(page);
  await gif.hold(1500);
  await page.getByRole("button", { name: "Mark as paid" }).click();
  await expect(page.getByTestId("admin-order-status")).toHaveText("Settled");
  await page.getByTestId("history").scrollIntoViewIfNeeded();
  await gif.hold(2200);
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByTestId("kpi-revenue")).toBeVisible();
  await gif.hold(2500);
  await gif.stop();
});
