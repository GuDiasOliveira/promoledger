/**
 * Outbox sync engine (Slice 4.2). Pure logic with injected dependencies so it is fully
 * testable with fake-indexeddb, a fake clock and a fake sender.
 *
 * Policy (approved):
 * - Strict FIFO per user: the oldest pending item goes first, and the run never skips ahead
 *   of a pending item that is still waiting for its retry time (a later order may depend on
 *   an earlier customer).
 * - Network error / 5xx / 429 -> stop the run, schedule a retry with exponential backoff.
 * - 401 -> stop everything until the user logs in again (items stay pending).
 * - 409 -> item becomes "conflict"; other 4xx -> "failed"; the run continues, but every later
 *   item depending on the rejected record (`deps`) is held, not sent (Slice 4.3 decision 1).
 * - The same Idempotency-Key is sent on every attempt (it is fixed in the outbox row).
 */
import { ApiError, NetworkError } from "@/lib/api/errors";
import type { OutboxItem, PromoLedgerDB } from "@/lib/db";

export const BASE_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 60_000;
export const JITTER = 0.2;

/** 1s, 2s, 4s, ... capped at 60s, with ±20% jitter (random in [0, 1)). */
export function backoffDelay(attempts: number, random: () => number): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(exponential * (1 - JITTER + 2 * JITTER * random()));
}

export type Sender = (item: OutboxItem) => Promise<void>;

export interface SyncDeps {
  db: PromoLedgerDB;
  userId: string;
  send: Sender;
  now?: () => number;
  random?: () => number;
  /** Called when an item is terminally rejected (to flag its local record). */
  onRejected?: (item: OutboxItem, status: "failed" | "conflict") => Promise<void>;
}

export type SyncOutcome =
  | "idle" // nothing pending
  | "done" // every due item was processed
  | "waiting" // head of the queue is waiting for its backoff time
  | "retrying" // transient failure: retry scheduled
  | "auth_required"; // 401: needs a new login

export interface SyncReport {
  outcome: SyncOutcome;
  sent: number;
  failed: number;
  /** Epoch ms when the engine should run again (for "waiting" / "retrying"). */
  nextRunAt: number | null;
}

function isTransient(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  return error instanceof ApiError && (error.status >= 500 || error.status === 429);
}

export async function pendingItems(db: PromoLedgerDB, userId: string): Promise<OutboxItem[]> {
  const rows = await db.outbox.where("userId").equals(userId).sortBy("seq");
  return rows.filter((row) => row.status === "pending");
}

/**
 * Pending items that must NOT be sent because something they depend on (an earlier
 * customer, order or action of the same order) was rejected or is itself held.
 * Transitive: customer failed -> its order held -> that order's actions held.
 * Shared by the engine and the UI, so both always agree on what is "on hold".
 */
export function blockedItems(queue: OutboxItem[]): Set<number> {
  const stuck = new Set<string>();
  const blocked = new Set<number>();
  for (const item of [...queue].sort((a, b) => a.seq! - b.seq!)) {
    if (item.status !== "pending") {
      stuck.add(item.localRef);
    } else if ((item.deps ?? []).some((dep) => stuck.has(dep))) {
      blocked.add(item.seq!);
      stuck.add(item.localRef);
    }
  }
  return blocked;
}

export async function runSync({
  db,
  userId,
  send,
  now = Date.now,
  random = Math.random,
  onRejected,
}: SyncDeps): Promise<SyncReport> {
  const queue = await db.outbox.where("userId").equals(userId).sortBy("seq");
  if (!queue.some((item) => item.status === "pending")) {
    return { outcome: "idle", sent: 0, failed: 0, nextRunAt: null };
  }

  let sent = 0;
  let failed = 0;
  // Refs that cannot be relied upon in this run (rejected or held), see blockedItems().
  const stuck = new Set<string>();
  for (const item of queue) {
    if (item.status !== "pending" || (item.deps ?? []).some((dep) => stuck.has(dep))) {
      stuck.add(item.localRef); // held items are skipped, never sent
      continue;
    }
    if (item.nextAttemptAt > now()) {
      return { outcome: "waiting", sent, failed, nextRunAt: item.nextAttemptAt };
    }
    try {
      await send(item);
      await db.outbox.delete(item.seq!);
      sent += 1;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return { outcome: "auth_required", sent, failed, nextRunAt: null };
      }
      if (isTransient(error)) {
        const attempts = item.attempts + 1;
        const nextAttemptAt = now() + backoffDelay(attempts, random);
        await db.outbox.update(item.seq!, {
          attempts,
          nextAttemptAt,
          lastError: error instanceof ApiError ? error.problem : null,
        });
        return { outcome: "retrying", sent, failed, nextRunAt: nextAttemptAt };
      }
      if (!(error instanceof ApiError)) throw error; // programming error: surface it
      const status = error.status === 409 ? "conflict" : "failed";
      await db.outbox.update(item.seq!, {
        status,
        attempts: item.attempts + 1,
        lastError: error.problem,
      });
      stuck.add(item.localRef);
      await onRejected?.(item, status);
      failed += 1;
    }
  }
  return { outcome: "done", sent, failed, nextRunAt: null };
}

/** User action: put a failed/conflicted/waiting item back at "send now" (same key!). */
export async function retryItem(db: PromoLedgerDB, seq: number): Promise<void> {
  await db.outbox.update(seq, { status: "pending", nextAttemptAt: 0 });
}
