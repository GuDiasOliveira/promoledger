"use client";

import { SerwistProvider, useSerwist } from "@serwist/turbopack/react";
import { type ReactNode, useEffect } from "react";

import { APP_SHELL } from "@/lib/pwa/shell";

/** Once the service worker is active (and we are online), cache every app page. */
function WarmAppShell() {
  const { serwist } = useSerwist();
  useEffect(() => {
    if (!serwist || !navigator.onLine) return;
    void navigator.serviceWorker.ready.then(() =>
      serwist.messageSW({ type: "CACHE_URLS", payload: { urlsToCache: [...APP_SHELL] } }),
    );
  }, [serwist]);
  return null;
}

/**
 * Registers the service worker in production builds only (offline caching makes dev confusing).
 * `reloadOnOnline` is OFF: the default reloads the page when the network returns, which would
 * wipe an order being typed. The sync runner already reacts to `online` without a reload.
 */
export function ServiceWorker({ children }: { children: ReactNode }) {
  return (
    <SerwistProvider
      swUrl="/serwist/sw.js"
      disable={process.env.NODE_ENV !== "production"}
      reloadOnOnline={false}
    >
      <WarmAppShell />
      {children}
    </SerwistProvider>
  );
}
