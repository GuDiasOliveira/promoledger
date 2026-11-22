import { expect, test } from "@playwright/test";

import {
  fillOrderWithNewCustomer,
  logInViaUi,
  openSellOnline,
  seedScenario,
  visibleForm,
  waitUntilOfflineReady,
} from "./helpers";

test("logging out wipes the typed credentials from the login screen", async ({ page }) => {
  const s = await seedScenario();
  await logInViaUi(page, s.seller); // typed into the form, then client-side navigation

  await page.getByRole("button", { name: "Log out" }).click(); // client-side back to /login
  await page.waitForURL("**/login");

  // Next.js keeps the hidden /login route (React <Activity>) — its state must be wiped.
  await expect(visibleForm(page).getByLabel("Email")).toHaveValue("");
  await expect(visibleForm(page).getByLabel("Password")).toHaveValue("");
});

test("queued changes belong to their author: never sent with another user's session", async ({
  page,
  context,
}) => {
  const s = await seedScenario();
  const sellerB = await s.addSeller("seller-b");

  // Seller A captures an order offline, then logs out with it still queued.
  await logInViaUi(page, s.seller);
  await openSellOnline(page, s.promotionId);
  await waitUntilOfflineReady(page); // logging out offline must still reach /login
  await context.setOffline(true);
  await fillOrderWithNewCustomer(page, "Queued By A");
  await page.getByRole("button", { name: "Save order" }).click();
  await expect(page.getByTestId("connectivity")).toContainText("2 to send");

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("2 changes have not been sent yet");
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL("**/login");

  // Seller B logs in on the same device, online: A's queue must stay untouched.
  await context.setOffline(false);
  await logInViaUi(page, sellerB);
  await page.goto(`/promotion/sync?id=${s.promotionId}`);
  await expect(page.getByText("Everything has been sent.")).toBeVisible(); // B sees none of A's
  await expect(page.getByTestId("connectivity")).not.toContainText("to send");
  expect(await s.orders()).toHaveLength(0);

  // A logs back in: A's queue is sent, attributed to A.
  await page.getByRole("button", { name: "Log out" }).click();
  await logInViaUi(page, s.seller);
  await expect.poll(async () => (await s.orders()).length).toBe(1);
  const [order] = await s.orders();
  expect(order.seller_member_id).toBe(s.sellerMemberId);
  expect(order.customer.name).toBe("Queued By A");
});
