import { expect, type Page, test } from "@playwright/test";

import { createAccount, createOrderAsSeller, logInViaUi, seedScenario } from "./helpers";

const main = (page: Page) => page.locator("main");

test("an admin sets up a whole promotion through the UI and a seller can sell", async ({ page, browser }) => {
  const admin = await createAccount("admin");
  const seller = await createAccount("seller");
  const org = `E2E Org ${crypto.randomUUID().slice(0, 8)}`;

  await logInViaUi(page, admin);
  await page.getByRole("link", { name: "+ New promotion" }).click();
  await page.getByLabel("Promotion name").fill("Spring Fair");
  await page.getByLabel("Search institution").fill(org);
  await page.getByRole("button", { name: `+ Create “${org}”` }).click();
  await expect(page.getByTestId("institution-choice")).toHaveText(org);
  await page.getByLabel("Sales start").fill("2026-03-01");
  await page.getByLabel("Last sales day").fill("2026-03-25");
  await page.getByLabel("Delivery day").fill("2026-03-30");
  await page.getByLabel("Currency").selectOption("BRL");
  await page.getByRole("button", { name: "Create promotion" }).click();

  // Products: a price typed with a decimal comma is stored exactly.
  await expect(page.getByRole("heading", { name: "Products" })).toBeVisible();
  const addForm = page.getByRole("form", { name: "Add product" });
  await addForm.getByLabel("Name").fill("Ovo 400g");
  await addForm.getByLabel("Price").fill("19,90");
  await expect(addForm.getByTestId("price-preview")).toHaveText("Shown as R$19.90");
  await addForm.getByRole("button", { name: "Add product" }).click();
  await expect(page.getByTestId("product-row")).toContainText("R$19.90");

  // Members: add the seller by email.
  await page.getByRole("link", { name: "Members" }).click();
  await page.getByLabel("Email of an existing account").fill(seller.email);
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(main(page).getByText("Member added.")).toBeVisible();

  // Settings: a draft can only be opened (never closed directly).
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("promotion-status")).toHaveText("Draft");
  await expect(page.getByRole("button", { name: "Close sales" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open sales" }).click();
  await expect(page.getByTestId("promotion-status")).toHaveText("Active");

  // The seller, on their own device, can now sell this product.
  const sellerPage = await (await browser.newContext({ locale: "en-US" })).newPage();
  await logInViaUi(sellerPage, seller);
  await sellerPage.getByRole("link", { name: /Spring Fair/ }).click();
  await sellerPage.getByRole("link", { name: "New order" }).click();
  await expect(sellerPage.getByText("Ovo 400g")).toBeVisible();
  await expect(sellerPage.getByText("R$19.90")).toBeVisible();
});

test("archiving hides a product from sellers and restoring brings it back", async ({ page, browser }) => {
  const s = await seedScenario();
  await logInViaUi(page, s.admin);
  await page.goto(`/promotion/admin/products?id=${s.promotionId}`);
  const bonbon = page.getByTestId("product-row").filter({ hasText: "Bonbon" });
  await bonbon.getByRole("button", { name: "Archive" }).click();
  await expect(bonbon).toContainText("Archived");

  const sellerPage = await (await browser.newContext({ locale: "en-US" })).newPage();
  await logInViaUi(sellerPage, s.seller);
  await sellerPage.goto(`/promotion/sell?id=${s.promotionId}`);
  await expect(sellerPage.getByText("Chocolate Egg")).toBeVisible();
  await expect(sellerPage.getByText("Bonbon")).toHaveCount(0);

  await bonbon.getByRole("button", { name: "Restore" }).click();
  await expect(bonbon).not.toContainText("Archived");
  await sellerPage.goto(`/promotion/sell?id=${s.promotionId}`); // a new visit refreshes the catalog
  await expect(sellerPage.getByText("Bonbon")).toBeVisible();
});

test("member management shows the server's rules as translated messages", async ({ page }) => {
  const s = await seedScenario();
  await logInViaUi(page, s.admin);
  await page.goto(`/promotion/admin/members?id=${s.promotionId}`);

  await page.getByLabel("Email of an existing account").fill("nobody-here@example.com");
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(main(page).getByRole("alert")).toHaveText(
    "No account exists with this email. Ask the person to sign up first.",
  );

  // The only admin tries to demote themself.
  const me = page.getByTestId("member-row").filter({ hasText: "(you)" });
  await me.getByRole("button", { name: "Edit roles" }).click();
  await me.getByLabel("Admin").uncheck();
  await me.getByLabel("Seller").check();
  await me.getByRole("button", { name: "Save" }).click();
  await expect(main(page).getByRole("alert")).toHaveText("A promotion must keep at least one admin.");
});

test("settings: currency locks after the first order; closing asks for confirmation", async ({ page }) => {
  const s = await seedScenario();
  await createOrderAsSeller(s, "First Order");
  await logInViaUi(page, s.admin);
  await page.goto(`/promotion/admin/settings?id=${s.promotionId}`);

  await page.getByLabel("Currency").selectOption("USD");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(main(page).getByRole("alert")).toHaveText(
    "The currency cannot change after the promotion has orders.",
  );

  await expect(page.getByRole("button", { name: "Open sales" })).toHaveCount(0);
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("New orders will no longer be accepted");
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Close sales" }).click();
  await expect(page.getByTestId("promotion-status")).toHaveText("Closed");
  await expect(page.getByRole("button", { name: "Reopen sales" })).toBeVisible();
});
