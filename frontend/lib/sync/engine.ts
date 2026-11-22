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
 * - 409 -> item becomes "conflict"; other 4xx -> "failed"; in both cases the run continues.
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

export async function runSync({
  db,
  userId,
  send,
  now = Date.now,
  random = Math.random,
  onRejected,
}: SyncDeps): Promise<SyncReport> {
  const queue = await pendingItems(db, userId);
  if (queue.length === 0) return { outcome: "idle", sent: 0, failed: 0, nextRunAt: null };

  let sent = 0;
  let failed = 0;
  for (const item of queue) {
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
