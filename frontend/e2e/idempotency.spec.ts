import { expect, test } from "@playwright/test";

import { fillOrderWithNewCustomer, logInViaUi, openSellOnline, seedScenario } from "./helpers";

// page.route() cannot see requests made by a service worker; this test is about the sync
// engine + server idempotency, so the SW is blocked here.
test.use({ serviceWorkers: "block" });

test("a lost response is retried with the same Idempotency-Key and never duplicates the order", async ({
  page,
}) => {
  const s = await seedScenario();
  const seen: { key: string | undefined; status: number | "dropped" }[] = [];

  await page.route("**/api/v1/promotions/*/orders", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const key = route.request().headers()["idempotency-key"];
    const response = await route.fetch(); // the server DOES process the request...
    if (seen.length === 0) {
      seen.push({ key, status: "dropped" });
      return route.abort("connectionreset"); // ...but the client never sees the answer.
    }
    seen.push({ key, status: response.status() });
    return route.fulfill({ response });
  });

  await logInViaUi(page, s.seller);
  await openSellOnline(page, s.promotionId);
  await fillOrderWithNewCustomer(page, "Lost Response");
  await page.getByRole("button", { name: "Save order" }).click();
  await page.getByRole("link", { name: "View sync queue" }).click();

  await expect(page.getByText("Everything has been sent.")).toBeVisible();

  expect(seen).toHaveLength(2);
  expect(seen[0].key).toBeTruthy();
  expect(seen[1].key).toBe(seen[0].key); // same key on the retry
  expect(seen[1].status).toBe(200); // idempotent replay, not a second 201
  expect(await s.orders()).toHaveLength(1); // exactly one order on the server
});
