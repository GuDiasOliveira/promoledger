import { expect, type Page } from "@playwright/test";

import { APP_SHELL } from "../lib/pwa/shell";

import { API_URL } from "./config";

const PASSWORD = "e2e-password-123";

interface Account {
  email: string;
  password: string;
  token: string;
}

async function call<T>(
  path: string,
  { token, method = "GET", body }: { token?: string; method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function createAccount(label: string): Promise<Account> {
  const email = `e2e-${label}-${crypto.randomUUID()}@example.com`;
  await call("/auth/register", { method: "POST", body: { name: `E2E ${label}`, email, password: PASSWORD } });
  const { access_token } = await call<{ access_token: string }>("/auth/token", {
    method: "POST",
    body: { email, password: PASSWORD },
  });
  return { email, password: PASSWORD, token: access_token };
}

export interface Scenario {
  promotionId: string;
  admin: Account;
  seller: Account;
  sellerMemberId: string;
  addSeller: (label: string) => Promise<Account & { memberId: string }>;
  addMember: (label: string, roles: string[]) => Promise<Account & { memberId: string }>;
  orders: () => Promise<ServerOrder[]>;
}

export interface ServerOrder {
  id: string;
  seller_member_id: string;
  total_amount: string;
  status_classification: string;
  customer: { name: string };
  items: { unit_price: string; quantity: number }[];
}

/** Admin + ACTIVE BRL promotion + 2 products + one seller, all through the real API. */
export async function seedScenario(): Promise<Scenario> {
  const admin = await createAccount("admin");
  const institution = await call<{ id: string }>("/institutions", {
    token: admin.token,
    method: "POST",
    body: { name: "E2E School" },
  });
  const promotion = await call<{ id: string }>("/promotions", {
    token: admin.token,
    method: "POST",
    body: {
      name: "E2E Easter Drive",
      institution_id: institution.id,
      sales_start_date: "2026-03-01",
      last_sales_date: "2026-03-25",
      delivery_date: "2026-03-30",
      currency: "BRL",
    },
  });
  const base = `/promotions/${promotion.id}`;
  await call(base, { token: admin.token, method: "PATCH", body: { status: "ACTIVE" } });
  for (const product of [
    { name: "Chocolate Egg", price: "19.90" },
    { name: "Bonbon", price: "0.10" },
  ]) {
    await call(`${base}/products`, { token: admin.token, method: "POST", body: product });
  }
  const addMember = async (label: string, roles: string[]) => {
    const account = await createAccount(label);
    const member = await call<{ id: string }>(`${base}/members`, {
      token: admin.token,
      method: "POST",
      body: { email: account.email, roles },
    });
    return { ...account, memberId: member.id };
  };
  const addSeller = (label: string) => addMember(label, ["seller"]);
  const seller = await addSeller("seller");
  return {
    promotionId: promotion.id,
    admin,
    seller,
    sellerMemberId: seller.memberId,
    addSeller,
    addMember,
    orders: async () =>
      (await call<{ items: ServerOrder[] }>(`${base}/orders?size=100`, { token: admin.token })).items,
  };
}

/** Log in through the real UI (credentials typed, like a user would). */
export async function logInViaUi(page: Page, account: { email: string; password: string }) {
  await page.goto("/login");
  const form = page.locator("form").filter({ visible: true });
  await form.getByLabel("Email").fill(account.email);
  await form.getByLabel("Password").fill(account.password);
  await form.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Your promotions" })).toBeVisible();
}

export const visibleForm = (page: Page) => page.locator("form").filter({ visible: true });

/**
 * Nothing may be wider than the phone screen. Horizontal overflow widens the mobile layout
 * viewport, which pushes `position: fixed; bottom: 0` bars (e.g. "Save order") off-screen.
 */
export async function expectNoHorizontalOverflow(page: Page) {
  const widest = await page.evaluate(() => {
    const limit = window.visualViewport?.width ?? window.innerWidth;
    let worst = { right: 0, element: "" };
    for (const el of document.querySelectorAll("body *")) {
      const { right, width } = el.getBoundingClientRect();
      if (width > 0 && right > worst.right) worst = { right, element: el.outerHTML.slice(0, 80) };
    }
    return { limit, ...worst };
  });
  expect(widest.right, `overflowing element: ${widest.element}`).toBeLessThanOrEqual(widest.limit + 0.5);
}

/**
 * Wait until the app can run with no network: the service worker is active and controls the
 * page, and EVERY app-shell page is in the HTML cache (not just one of them).
 */
export async function waitUntilOfflineReady(page: Page) {
  await page.waitForFunction(
    async (shell) => {
      const registration = await navigator.serviceWorker?.getRegistration();
      if (!registration?.active || !navigator.serviceWorker.controller) return false;
      const cache = await caches.open("pages");
      const cached = await Promise.all(
        shell.map((path) => cache.match(path, { ignoreSearch: true, ignoreVary: true })),
      );
      return cached.every(Boolean);
    },
    [...APP_SHELL],
    { polling: 250 },
  );
  // Readiness is proven, not assumed: reload online until the document itself was served
  // through the service worker (workerStart > 0). Only then is an offline launch guaranteed.
  await expect
    .poll(
      async () => {
        await page.reload();
        return page.evaluate(() => {
          const [nav] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
          return (nav?.workerStart ?? 0) > 0;
        });
      },
      { intervals: [250, 500, 1000] },
    )
    .toBe(true);
}

/** Open the order screen online once, so the catalog and customers are downloaded. */
export async function openSellOnline(page: Page, promotionId: string) {
  await page.goto(`/promotion?id=${promotionId}`);
  await page.getByRole("link", { name: "New order" }).click();
  await expect(page.getByText("Chocolate Egg")).toBeVisible();
}

export async function fillOrderWithNewCustomer(page: Page, customerName: string) {
  await page.getByLabel("Search by name or contact").fill(customerName);
  await page.getByRole("button", { name: "+ New customer" }).click();
  await page.getByRole("button", { name: "Add customer" }).click();
  for (let i = 0; i < 2; i += 1) await page.getByRole("button", { name: "Add one Chocolate Egg" }).click();
  for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "Add one Bonbon" }).click();
}

export interface ServerOrderDetail extends ServerOrder {
  version: number;
  paid_at: string | null;
  delivered_at: string | null;
  audit_events: { event_type: string; actor_member_id: string; reason: string | null }[];
}

/** Seller creates a customer + order through the API (as if captured earlier). */
export async function createOrderAsSeller(
  s: Scenario,
  customerName: string,
  {
    markPaidNow = false,
    seller = s.seller,
    lines = [["Chocolate Egg", 1]],
  }: { markPaidNow?: boolean; seller?: Account; lines?: [string, number][] } = {},
): Promise<string> {
  const base = `/promotions/${s.promotionId}`;
  const customer = await call<{ id: string }>(`${base}/customers`, {
    token: seller.token,
    method: "POST",
    body: { name: customerName },
  });
  const products = await call<{ items: { id: string; name: string }[] }>(`${base}/products`, {
    token: seller.token,
  });
  const productId = (name: string) => products.items.find((p) => p.name === name)!.id;
  const res = await fetch(`${API_URL}${base}/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${seller.token}`,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      customer_id: customer.id,
      items: lines.map(([name, quantity]) => ({ product_id: productId(name), quantity })),
      mark_paid_now: markPaidNow,
    }),
  });
  if (!res.ok) throw new Error(`create order -> ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

/** The "someone else": an admin changing the order through the API meanwhile. */
export async function adminTransition(
  s: Scenario,
  orderId: string,
  path: "payment" | "delivery" | "cancel",
  body: Record<string, unknown>,
): Promise<ServerOrderDetail> {
  const res = await fetch(`${API_URL}/promotions/${s.promotionId}/orders/${orderId}/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${s.admin.token}`,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`admin ${path} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as ServerOrderDetail;
}

export async function summaryFromApi(s: Scenario) {
  return call<{
    total_revenue: string;
    collected_amount: string;
    outstanding_amount: string;
    units_ordered: number;
    units_delivered: number;
  }>(`/promotions/${s.promotionId}/reconciliation/summary`, { token: s.admin.token });
}

export async function serverOrder(s: Scenario, orderId: string): Promise<ServerOrderDetail> {
  return call<ServerOrderDetail>(`/promotions/${s.promotionId}/orders/${orderId}`, { token: s.admin.token });
}

/** Open "My orders" and then the order of `customerName`. */
export async function openOrder(page: Page, promotionId: string, customerName: string) {
  await page.goto(`/promotion/orders?id=${promotionId}`);
  await page.getByTestId("order-card").filter({ hasText: customerName }).click();
  await expect(page.getByRole("heading", { name: `Order for ${customerName}` })).toBeVisible();
}
