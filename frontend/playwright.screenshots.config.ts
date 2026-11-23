import { defineConfig, devices } from "@playwright/test";

import base from "./playwright.config";

/**
 * README screenshots and GIFs (`npm run screenshots`), written to `docs/screenshots/`.
 *
 * Same stack as the E2E suite (production build on :3001, API on :8001, fresh
 * `promoledger_e2e` database), but seeded with `scripts/seed.py --lang en` so the pictures show
 * a realistic promotion. Not a test suite: it is not part of `test:e2e` nor of CI.
 */
export default defineConfig({
  ...base,
  testDir: "screenshots",
  timeout: 180_000,
  projects: [
    { name: "seed", testMatch: /seed\.setup\.ts/ },
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts/,
      dependencies: ["seed"],
      use: { ...devices["Pixel 7"], deviceScaleFactor: 2 },
    },
    {
      name: "desktop",
      testMatch: /desktop\.spec\.ts/,
      dependencies: ["seed"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 2,
      },
    },
  ],
});
