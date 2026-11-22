import { expect, test } from "@playwright/test";

import {
  adminTransition,
  createOrderAsSeller,
  logInViaUi,
  type Scenario,
  seedScenario,
  serverOrder,
  summaryFromApi,
} from "./helpers";

/**
 * Seller A: "Ana Settled" 2 × Egg (39.80) paid + delivered; "Ana Paid" 3 × Bonbon (0.30) paid.
 * Seller B: "Bia Divergence" 1 × Egg (19.90) delivered, unpaid; "Bia Unpaid" 1 × Egg (19.90).
 */
async function seedLedger() {
  const s = await seedScenario();
  const sellerB = await s.addSeller("seller-b");
  const settled = await createOrderAsSeller(s, "Ana Settled", { markPaidNow: true, lines: [["Chocolate Egg", 2]] });
  await adminTransition(s, settled, "delivery", { action: "MARK_DELIVERED", expected_version: 1 });
  await createOrderAsSeller(s, "Ana Paid", { markPaidNow: true, lines: [["Bonbon", 3]] });
  const divergence = await createOrderAsSeller(s, "Bia Divergence", { seller: sellerB });
  await adminTransition(s, divergence, "delivery", { action: "MARK_DELIVERED", expected_version: 1 });
  const unpaid = await createOrderAsSeller(s, "Bia Unpaid", { seller: sellerB });
  return { s, divergence, unpaid };
}

async function openDashboard(page: import("@playwright/test").Page, s: Scenario, account = s.admin) {
  await logInViaUi(page, account);
  await page.goto(`/promotion?id=${s.promotionId}`);
  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByTestId("kpi-revenue")).toBeVisible();
}

test("dashboard shows the exact server totals and the seller ranking", async ({ page }) => {
  const { s } = await seedLedger();
  await openDashboard(page, s);

  const api = await summaryFromApi(s);
  expect(api).toMatchObject({ total_revenue: "79.90", collected_amount: "40.10", outstanding_amount: "39.80" });
  await expect(page.getByTestId("kpi-revenue")).toHaveText("R$79.90");
  await expect(page.getByTestId("kpi-collected")).toHaveText("R$40.10");
  await expect(page.getByTestId("kpi-outstanding")).toHaveText("R$39.80");
  await expect(page.getByTestId("kpi-units")).toHaveText("3 of 7");
  await expect(page.getByTestId("bucket-DIVERGENCE")).toContainText("R$19.90");
  await expect(page.getByTestId("bucket-DIVERGENCE")).toContainText("1 order");

  const rows = page.getByTestId("leaderboard").locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("E2E seller"); // A: gross 40.10 ranks first
  await expect(rows.nth(0)).toContainText("R$40.10");
  await expect(rows.nth(0)).toContainText("99.25%"); // 39.80 / 40.10, exact server string
  await expect(rows.nth(1)).toContainText("E2E seller-b");
  await expect(rows.nth(1)).toContainText("0.00%");
});

test("admin resolves a divergence from the dashboard and the totals follow", async ({ page }) => {
  const { s, divergence } = await seedLedger();
  await openDashboard(page, s);

  await page.getByTestId("divergences").getByRole("link", { name: /Bia Divergence/ }).click();
  await expect(page.getByTestId("admin-order-status")).toHaveText("Delivered · unpaid");
  await page.getByRole("button", { name: "Mark as paid" }).click();
  await expect(page.getByTestId("admin-order-status")).toHaveText("Settled");
  await expect(page.getByTestId("history")).toContainText("Payment received · E2E admin");

  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByText("No divergences.")).toBeVisible();
  await expect(page.getByTestId("kpi-collected")).toHaveText("R$60.00");
  expect((await serverOrder(s, divergence)).status_classification).toBe("SETTLED");
});

test("a stale admin action gets the conflict message and the fresh state, then succeeds", async ({ page }) => {
  const { s, unpaid } = await seedLedger();
  await logInViaUi(page, s.admin);
  await page.goto(`/promotion/admin/order?id=${s.promotionId}&order=${unpaid}`);
  await expect(page.getByTestId("admin-order-status")).toHaveText("Unpaid");

  // Meanwhile, someone else (another session, through the API) records the payment: v1 -> v2.
  await adminTransition(s, unpaid, "payment", { action: "MARK_PAID", expected_version: 1 });

  await page.getByRole("button", { name: "Mark as delivered" }).click(); // sent with stale v1
  await expect(page.locator("main").getByRole("alert")).toContainText("This order was changed by someone else");
  await expect(page.getByTestId("admin-order-status")).toHaveText("Paid · to deliver"); // reloaded

  await page.getByRole("button", { name: "Mark as delivered" }).click(); // deliberate retry, v2
  await expect(page.getByTestId("admin-order-status")).toHaveText("Settled");
  expect((await serverOrder(s, unpaid)).version).toBe(3);
});

test("a viewer sees the dashboard read-only: no actions, no audit trail", async ({ page }) => {
  const { s, divergence } = await seedLedger();
  const viewer = await s.addMember("viewer", ["promotion_viewer"]);
  await openDashboard(page, s, viewer);

  await expect(page.getByRole("link", { name: "Audit trail" })).toHaveCount(0);
  await page.goto(`/promotion/admin/order?id=${s.promotionId}&order=${divergence}`);
  await expect(page.getByTestId("admin-order-status")).toHaveText("Delivered · unpaid");
  await expect(page.getByRole("button", { name: "Mark as paid" })).toHaveCount(0);

  await page.goto(`/promotion/admin/audit?id=${s.promotionId}`);
  await expect(page.locator("main").getByRole("alert")).toHaveText("You do not have permission to do this.");
});

test("a seller has no access to the dashboard", async ({ page }) => {
  const { s } = await seedLedger();
  await logInViaUi(page, s.seller);
  await page.goto(`/promotion?id=${s.promotionId}`);
  await expect(page.getByRole("link", { name: "New order" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveCount(0);

  await page.goto(`/promotion/admin?id=${s.promotionId}`);
  await expect(page.locator("main").getByRole("alert")).toHaveText("You do not have permission to do this.");
});
