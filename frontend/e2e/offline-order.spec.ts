import { expect, test } from "@playwright/test";

import {
  expectNoHorizontalOverflow,
  fillOrderWithNewCustomer,
  logInViaUi,
  openSellOnline,
  seedScenario,
  waitUntilOfflineReady,
} from "./helpers";

test("a seller captures an order with no connection and it syncs exactly once", async ({
  page,
  context,
}) => {
  const s = await seedScenario();
  await logInViaUi(page, s.seller);
  await openSellOnline(page, s.promotionId);

  // The service worker controls the page and has cached the whole app shell (incl. screens
  // never visited, like the sync queue).
  await waitUntilOfflineReady(page);

  // --- No connection from here on ------------------------------------------------------
  await context.setOffline(true);
  await page.reload(); // the app must load from the device alone
  await expect(page.getByTestId("connectivity")).toContainText("Offline");
  await expect(page.getByText("Chocolate Egg")).toBeVisible(); // catalog from IndexedDB

  await fillOrderWithNewCustomer(page, "Maria Offline");
  // 2 × 19.90 + 3 × 0.10 — exact decimal arithmetic, formatted for en-US in BRL.
  await expect(page.getByTestId("order-total")).toHaveText("R$40.10");
  // Offline header (status + pending badges) is the widest state: it must still fit the phone.
  await expectNoHorizontalOverflow(page);
  await page.getByLabel("Payment received now").check();
  await page.getByRole("button", { name: "Save order" }).click();
  await expect(page.getByText("Order saved. It will be sent automatically.")).toBeVisible();
  await expect(page.getByTestId("connectivity")).toContainText("2 to send");

  // A screen never opened online still loads offline (pre-cached shell, `?id=` ignored).
  await page.goto(`/promotion/sync?id=${s.promotionId}`);
  await expect(page.getByTestId("outbox-item")).toHaveCount(2);
  expect(await s.orders()).toHaveLength(0); // nothing reached the server

  // --- Connection is back ----------------------------------------------------------------
  await context.setOffline(false);
  await expect(page.getByText("Everything has been sent.")).toBeVisible();

  const orders = await s.orders();
  expect(orders).toHaveLength(1);
  const [order] = orders;
  expect(order.customer.name).toBe("Maria Offline");
  expect(order.total_amount).toBe("40.10");
  expect(order.status_classification).toBe("PAID_PENDING");
  expect(order.seller_member_id).toBe(s.sellerMemberId);
  expect(order.items.map((i) => i.unit_price).sort()).toEqual(["0.10", "19.90"]);
});
