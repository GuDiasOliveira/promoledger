/**
 * Every page of the app. All are static (promotion pages read `?id=` on the client), so
 * caching these few HTML documents is enough to open any screen offline.
 * Keep in sync with app/ routes (asserted by lib/pwa/shell.test.ts).
 */
export const APP_SHELL = [
  "/",
  "/login",
  "/register",
  "/promotions",
  "/promotion",
  "/promotion/sell",
  "/promotion/sync",
  "/promotion/orders",
  "/promotion/order",
  "/promotion/admin",
  "/promotion/admin/orders",
  "/promotion/admin/order",
  "/promotion/admin/audit",
  "/promotion/admin/products",
  "/promotion/admin/members",
  "/promotion/admin/settings",
  "/promotions/new",
] as const;
