/// <reference lib="webworker" />
/**
 * Service worker (bundled by Serwist via app/serwist/[path]/route.ts).
 *
 * Rules, in order (first match wins):
 * 1. /api/*            -> NetworkOnly. API data is NEVER cached here: offline data lives in
 *                         IndexedDB, per user. Caching API responses in the SW could serve one
 *                         user's data to the next user of a shared device.
 * 2. App pages (HTML)  -> NetworkFirst, matched IGNORING the query string (and Vary): the
 *                         promotion pages are static (`/promotion/sell?id=…`), so one cached HTML
 *                         serves every promotion offline. Covers real navigations AND the warm-up
 *                         requests for APP_SHELL sent by the client (CACHE_URLS), so screens never
 *                         visited online still open offline.
 * 3. RSC payloads      -> NetworkFirst, ignoring the query (`?id=…&_rsc=…`), same reason.
 * 4. Serwist defaults  -> static assets (JS/CSS/fonts/images).
 */
import { defaultCache, PAGES_CACHE_NAME } from "@serwist/turbopack/worker";
import {
  ExpirationPlugin,
  NetworkFirst,
  NetworkOnly,
  type PrecacheEntry,
  Serwist,
  type SerwistGlobalConfig,
} from "serwist";

import { APP_SHELL } from "@/lib/pwa/shell";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const SHELL = new Set<string>(APP_SHELL);
const ignoreSearch = { ignoreSearch: true } as const;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: ({ sameOrigin, url }) => sameOrigin && url.pathname.startsWith("/api/"),
      handler: new NetworkOnly(),
    },
    {
      matcher: ({ request, sameOrigin, url }) =>
        sameOrigin &&
        request.headers.get("RSC") !== "1" &&
        (request.mode === "navigate" || SHELL.has(url.pathname)),
      handler: new NetworkFirst({
        cacheName: PAGES_CACHE_NAME.html,
        matchOptions: { ignoreSearch: true, ignoreVary: true },
        networkTimeoutSeconds: 5,
        plugins: [new ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 30 * 24 * 60 * 60 })],
      }),
    },
    {
      matcher: ({ request, sameOrigin }) => sameOrigin && request.headers.get("RSC") === "1",
      handler: new NetworkFirst({
        cacheName: PAGES_CACHE_NAME.rsc,
        matchOptions: ignoreSearch,
        networkTimeoutSeconds: 5,
        plugins: [new ExpirationPlugin({ maxEntries: 64, maxAgeSeconds: 30 * 24 * 60 * 60 })],
      }),
    },
    ...defaultCache,
  ],
});

serwist.addEventListeners();
