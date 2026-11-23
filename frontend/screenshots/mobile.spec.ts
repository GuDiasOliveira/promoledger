import { expect, test, type Page } from "@playwright/test";

import { waitUntilOfflineReady } from "../e2e/helpers";

import { GifRecorder, logIn, readState, SELLER, shot, showClicks } from "./helpers";

// The seller's side: a phone, often with a bad connection.

const BRIGADEIRO = "Brigadeiro box (12 pcs)";
const TRUFFLE = "Assorted truffle (each)";

async function addItems(page: Page, slow = false) {
  const add = async (name: string, times: number) => {
    for (let i = 0; i < times; i += 1) {
      await page.getByRole("button", { name: `Add one ${name}` }).click();
      if (slow) await page.waitForTimeout(250);
    }
  };
  await add(BRIGADEIRO, 2);
  await add(TRUFFLE, 3);
}

test("seller screens", async ({ page }) => {
  const { promotionId } = readState();
  await logIn(page, SELLER);
  await shot(page, "mobile-promotions");

  await page.goto(`/promotion?id=${promotionId}`);
  await expect(page.getByRole("link", { name: "New order" })).toBeVisible();
  await shot(page, "mobile-promotion");

  await page.getByRole("link", { name: "New order" }).click();
  await expect(page.getByText(BRIGADEIRO)).toBeVisible();
  await page.getByLabel("Search by name or contact").fill("Alice");
  await page.getByRole("button", { name: /Alice Prado/ }).click();
  await addItems(page);
  await expect(page.getByTestId("order-total")).toHaveText("R$96.25");
  await shot(page, "mobile-new-order");

  await page.goto(`/promotion/orders?id=${promotionId}`);
  await expect(page.getByTestId("order-card").first()).toBeVisible();
  await shot(page, "mobile-my-orders");

  // An order with history (delivered, still unpaid) rather than a blank new one.
  await page.getByTestId("order-card").filter({ hasText: "Delivered · unpaid" }).first().click();
  await expect(page.getByRole("heading", { name: /Order for/ })).toBeVisible();
  await shot(page, "mobile-order-detail");
});

test("GIF: an order captured offline syncs when the connection returns", async ({
  page,
  context,
}) => {
  const { promotionId } = readState();
  await logIn(page, SELLER);
  await page.goto(`/promotion?id=${promotionId}`);
  await page.getByRole("link", { name: "New order" }).click();
  await expect(page.getByText(BRIGADEIRO)).toBeVisible();
  await waitUntilOfflineReady(page); // reloads until the service worker serves the page

  // --- recording ---
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("connectivity")).toContainText("Offline");
  await showClicks(page);
  const gif = new GifRecorder(page, "offline-order", 412);
  await gif.start();
  await gif.hold(1200);

  await page.getByLabel("Search by name or contact").pressSequentially("Laura Mendes", {
    delay: 70,
  });
  await page.getByRole("button", { name: "+ New customer" }).click();
  await gif.hold(500);
  await page.getByRole("button", { name: "Add customer" }).click();
  await gif.hold(400);
  await addItems(page, true);
  await page.getByLabel("Payment received now").check();
  await gif.hold(800);
  await page.getByRole("button", { name: "Save order" }).click();
  await expect(page.getByTestId("connectivity")).toContainText("2 to send");
  await gif.hold(1500);

  await page.getByRole("link", { name: "View sync queue" }).click();
  await expect(page.getByTestId("outbox-item")).toHaveCount(2);
  await showClicks(page);
  await shot(page, "mobile-sync-queue-offline"); // still image for the README grid
  await gif.hold(1500);

  await context.setOffline(false); // connection is back: the queue drains by itself
  await expect(page.getByText("Everything has been sent.")).toBeVisible();
  await gif.hold(2200);
  await gif.stop();
});
