import { expect, test } from "@playwright/test";

import { API_URL } from "./config";
import { createAccount, logInViaUi } from "./helpers";

const callWith = (token: string, method = "GET", path = "/auth/me") =>
  fetch(`${API_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify({ name: "write attempt" }),
  });

test("a read-only API token is shown once, works for reading only, and can be revoked", async ({
  page,
}) => {
  const account = await createAccount("tokens");
  await logInViaUi(page, account);
  await page.getByRole("link", { name: "API tokens" }).click();

  await page.getByLabel("Token name").fill("Claude Desktop");
  await page.getByRole("button", { name: "Create token" }).click();
  const secret = await page.getByTestId("new-token").textContent();
  expect(secret).toMatch(/^pl_[\w-]{40,}$/);

  // Works for reading, refused for writing (enforced by the API, not the client).
  expect((await callWith(secret!)).status).toBe(200);
  const write = await callWith(secret!, "POST", "/institutions");
  expect(write.status).toBe(403);
  expect((await write.json()).code).toBe("TOKEN_READ_ONLY");

  // Never shown again: after a reload only the prefix remains.
  await page.reload();
  await expect(page.getByTestId("new-token")).toHaveCount(0);
  const row = page.getByTestId("token-row").filter({ hasText: "Claude Desktop" });
  await expect(row).toContainText(secret!.slice(0, 10));
  await expect(row).not.toContainText(secret!);
  await expect(row).toContainText("Active");

  page.once("dialog", (dialog) => void dialog.accept());
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toContainText("Revoked");
  expect((await callWith(secret!)).status).toBe(401);
});
