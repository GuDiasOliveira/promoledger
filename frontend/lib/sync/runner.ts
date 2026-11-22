/**
 * Browser-side scheduler for the sync engine: decides *when* to run it.
 * Triggers: explicit request (after enqueue / "retry now"), `online`, tab becoming visible,
 * a 30s heartbeat, and the next retry time reported by the engine.
 */
import { clearToken, getUserId } from "@/lib/auth/session";
import { db } from "@/lib/db";

import { runSync, type SyncOutcome } from "./engine";
import { markLocalRecord } from "./outbox";
import { apiSender } from "./send";

const HEARTBEAT_MS = 30_000;
const LOCK_NAME = "promoledger-sync";

let retryTimer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
let lastOutcome: SyncOutcome | null = null;
const listeners = new Set<() => void>();

export function getLastOutcome(): SyncOutcome | null {
  return lastOutcome;
}

export function subscribeOutcome(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One run at a time per *device*: Web Locks cover other tabs, `inFlight` this tab. */
async function withSyncLock(fn: () => Promise<void>): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    if (typeof navigator !== "undefined" && navigator.locks) {
      await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (lock) await fn();
      });
    } else {
      await fn();
    }
  } finally {
    inFlight = false;
  }
}

async function runOnce(): Promise<void> {
  const userId = getUserId();
  if (!userId) return;
  await withSyncLock(async () => {
    const report = await runSync({
      db,
      userId,
      send: apiSender(db),
      onRejected: (item, status) => markLocalRecord(db, item, status),
    });
    lastOutcome = report.outcome;
    for (const listener of listeners) listener();

    clearTimeout(retryTimer);
    if (report.nextRunAt !== null) {
      retryTimer = setTimeout(() => void runOnce(), Math.max(0, report.nextRunAt - Date.now()));
    }
    if (report.outcome === "auth_required") {
      // The queue stays intact (scoped to this user) and resumes after the next login.
      clearToken();
    }
  });
}

/** Ask for a sync as soon as possible (e.g. right after saving an order offline). */
export function requestSync(): void {
  void runOnce();
}

/** Install the triggers; returns a cleanup function. */
export function startSyncRunner(): () => void {
  const onVisible = () => document.visibilityState === "visible" && requestSync();
  window.addEventListener("online", requestSync);
  document.addEventListener("visibilitychange", onVisible);
  const heartbeat = setInterval(requestSync, HEARTBEAT_MS);
  requestSync();
  return () => {
    window.removeEventListener("online", requestSync);
    document.removeEventListener("visibilitychange", onVisible);
    clearInterval(heartbeat);
    clearTimeout(retryTimer);
  };
}
