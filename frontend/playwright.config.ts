import { defineConfig, devices } from "@playwright/test";

import { API_PORT, E2E_DATABASE_URL, WEB_PORT } from "./e2e/config";

/**
 * E2E against a PRODUCTION build (the service worker only runs in production), with its own
 * ports and database so it never interferes with local dev or the pytest suite.
 */
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    locale: "en-US",
    trace: "retain-on-failure",
  },
  projects: [
    // Mobile-first: the seller flows run on phones.
    { name: "mobile", testIgnore: /admin-.*\.spec\.ts/, use: { ...devices["Pixel 7"] } },
    // The admin dashboard is a desktop tool (Slice 4.4, decision 3).
    { name: "desktop", testMatch: /admin-.*\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      command: `uv run uvicorn app.main:app --port ${API_PORT}`,
      cwd: "../backend",
      url: `http://localhost:${API_PORT}/docs`,
      env: { DATABASE_URL: E2E_DATABASE_URL },
      reuseExistingServer: false,
    },
    {
      // rewrites() are resolved at build time, so the build must target the E2E backend.
      command: `npm run build && npm run start -- -p ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/login`,
      env: { BACKEND_URL: `http://localhost:${API_PORT}` },
      timeout: 240_000,
      reuseExistingServer: false,
    },
  ],
});
