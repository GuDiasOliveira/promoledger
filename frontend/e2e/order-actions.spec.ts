import { expect, type Page, test } from "@playwright/test";

import {
  adminTransition,
  createOrderAsSeller,
  fillOrderWithNewCustomer,
  logInViaUi,
  openOrder,
  openSellOnline,
  seedScenario,
  serverOrder,
  waitUntilOfflineReady,
} from "./helpers";

const status = (page: Page) =>
  page
    .locator("main")
    .getByText(/^(Unpaid|Paid · to deliver|Delivered · unpaid|Settled|Cancelled)$/)
    .first();

test("actions chained offline on an order that was never sent reach the server in order", async ({
  page,
  context,
}) => {
  const s = await seedScenario();
  await logInViaUi(page, s.seller);
  await openSellOnline(page, s.promotionId);
  await waitUntilOfflineReady(page);

  await context.setOffline(true);
  await fillOrderWithNewCustomer(page, "Chain Offline");
  await page.getByRole("button", { name: "Save order" }).click();
  await expect(page.getByText("Order saved. It will be sent automatically.")).toBeVisible();

  await openOrder(page, s.promotionId, "Chain Offline");
  await page.getByRole("button", { name: "Mark as paid" }).click();
  await expect(status(page)).toHaveText("Paid · to deliver");
  await page.getByRole("button", { name: "Mark as delivered" }).click();
  await expect(status(page)).toHaveText("Settled");
  // creation + 2 actions, all still on the device
  await expect(page.getByText("3 actions waiting to be sent")).toBeVisible();
  expect(await s.orders()).toHaveLength(0);

  await context.setOffline(false);
  await expect(page.getByTestId("history")).toContainText("Delivered"); // server history arrived
  await expect(page.getByText(/actions? waiting to be sent/)).toHaveCount(0);

  const [summary] = await s.orders();
  const order = await serverOrder(s, summary.id);
  expect(order.status_classification).toBe("SETTLED");
  expect(order.version).toBe(3);
  expect(order.audit_events.map((e) => e.event_type)).toEqual([
    "PAYMENT_MARKED",
    "DELIVERY_MARKED",
  ]);
});

test("conflict: someone paid meanwhile -> 'Reapply my actions' rebases the delivery", async ({
  page,
  context,
}) => {
  const s = await seedScenario();
  const orderId = await createOrderAsSeller(s, "Conflict Reapply");
  await logInViaUi(page, s.seller);
  await openOrder(page, s.promotionId, "Conflict Reapply");
  await waitUntilOfflineReady(page);

  await context.setOffline(true);
  await page.getByRole("button", { name: "Mark as delivered" }).click(); // queued with expected_version 1
  await expect(status(page)).toHaveText("Delivered · unpaid");

  await adminTransition(s, orderId, "payment", { action: "MARK_PAID", expected_version: 1 }); // v1 -> v2
  await context.setOffline(false);

  const conflict = page.getByRole("region", { name: "Someone else changed this order" });
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText("Now on the server: Paid · to deliver");
  // While unresolved, the order shows the SERVER truth (not "Settled"), with product names.
  await expect(status(page)).toHaveText("Paid · to deliver");
  await expect(page.getByText("1 × Chocolate Egg")).toBeVisible();
  await conflict.getByRole("button", { name: "Reapply my actions" }).click();

  await expect(conflict).toHaveCount(0);
  await expect(status(page)).toHaveText("Settled");
  await expect.poll(async () => (await serverOrder(s, orderId)).version).toBe(3);
  const order = await serverOrder(s, orderId);
  expect(order.status_classification).toBe("SETTLED");
  expect(
    order.audit_events.map((e) => [e.event_type, e.actor_member_id === s.sellerMemberId]),
  ).toEqual([
    ["PAYMENT_MARKED", false], // the admin
    ["DELIVERY_MARKED", true], // the seller's reapplied action
  ]);
});

test("conflict: someone already did the same thing -> nothing to apply", async ({
  page,
  context,
}) => {
  const s = await seedScenario();
  const orderId = await createOrderAsSeller(s, "Same Change");
  await logInViaUi(page, s.seller);
  await openOrder(page, s.promotionId, "Same Change");
  await waitUntilOfflineReady(page);

  await context.setOffline(true);
  await page.getByRole("button", { name: "Mark as delivered" }).click();
  await adminTransition(s, orderId, "delivery", { action: "MARK_DELIVERED", expected_version: 1 });
  await context.setOffline(false);

  const conflict = page.getByRole("region", { name: "Someone else changed this order" });
  await expect(conflict.getByTestId("nothing-to-apply")).toBeVisible();
  await expect(conflict.getByRole("button", { name: "Reapply my actions" })).toHaveCount(0);
  await conflict.getByRole("button", { name: "OK, got it" }).click();

  await expect(conflict).toHaveCount(0);
  await expect(status(page)).toHaveText("Delivered · unpaid");
  const order = await serverOrder(s, orderId);
  expect(order.version).toBe(2); // only the admin's change: no duplicate delivery
  expect(order.audit_events.map((e) => e.event_type)).toEqual(["DELIVERY_MARKED"]);
});

test("revoking a payment requires a reason, which is recorded in the audit trail", async ({
  page,
}) => {
  const s = await seedScenario();
  const orderId = await createOrderAsSeller(s, "Needs Reason", { markPaidNow: true });
  await logInViaUi(page, s.seller);
  await openOrder(page, s.promotionId, "Needs Reason");

  await page.getByRole("button", { name: "Revoke payment" }).click();
  const form = page.getByRole("form", { name: "Revoke payment" });
  const confirm = form.getByRole("button", { name: "Confirm" });
  await expect(confirm).toBeDisabled();
  await form.getByLabel("Reason (required)").fill("   ");
  await expect(confirm).toBeDisabled(); // blank is not a reason
  await form.getByLabel("Reason (required)").fill("Transfer bounced");
  await confirm.click();

  await expect(status(page)).toHaveText("Unpaid");
  await expect.poll(async () => (await serverOrder(s, orderId)).version).toBe(2);
  const order = await serverOrder(s, orderId);
  expect(order.audit_events.at(-1)).toMatchObject({
    event_type: "PAYMENT_REVOKED",
    reason: "Transfer bounced",
  });
});
