/**
 * Local (IndexedDB) store — the offline read model and the outbox.
 *
 * EVERY row is scoped by `userId`: devices are often shared by volunteers, and one user's
 * cached data or queued mutations must never be shown to, or sent as, another user.
 * Cache keys are `${userId}:${...}` strings so a single primary key covers the scope.
 */
import Dexie, { type EntityTable } from "dexie";

import type { ProblemDetails } from "@/lib/api/errors";

export type SyncState = "pending" | "synced" | "failed" | "conflict";

export interface CachedPromotion {
  key: string; // `${userId}:${id}`
  userId: string;
  id: string;
  name: string;
  status: "DRAFT" | "ACTIVE" | "CLOSED";
  currency: string;
  salesStartDate: string;
  lastSalesDate: string;
  deliveryDate: string;
  roles: string[];
  memberId: string;
}

export interface CachedProduct {
  key: string; // `${userId}:${promotionId}:${id}`
  userId: string;
  promotionId: string;
  id: string;
  name: string;
  description: string | null;
  price: string; // exact decimal string, as sent by the API
}

export interface CachedCustomer {
  key: string; // `${userId}:${promotionId}:${id}`
  userId: string;
  promotionId: string;
  id: string; // client-generated UUIDv4 when created offline
  name: string;
  contact: string | null;
  sync: SyncState;
}

export interface LocalOrderLine {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: string; // exact decimal string (server snapshot once synced)
}

export interface AuditEntry {
  id: string;
  eventType: string;
  reason: string | null;
  createdAt: string;
}

/**
 * Last known SERVER state of an order (or the optimistic creation, before it is sent).
 * Pending transitions are NOT written here: the UI derives the displayed state as
 * snapshot + queued actions (lib/orders/state.ts), so it can never drift from the server.
 */
export interface CachedOrder {
  key: string; // `${userId}:${ref}`
  ref: string; // idempotency key (created on this device) or `srv:${serverId}`
  userId: string;
  promotionId: string;
  serverId: string | null;
  version: number; // server version (1 for a not-yet-sent creation)
  customerId: string;
  customerName: string;
  lines: LocalOrderLine[];
  markPaidNow: boolean;
  paidAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  total: string | null; // authoritative total once synced
  createdAt: string;
  sync: SyncState; // state of the *creation*
  auditEvents: AuditEntry[] | null; // known once fetched/returned by the server
}

export type OutboxKind = "createCustomer" | "createOrder" | "transition";

export type TransitionKind =
  | "MARK_PAID"
  | "REVOKE_PAYMENT"
  | "MARK_DELIVERED"
  | "REVOKE_DELIVERY"
  | "CANCEL";

export interface OutboxItem {
  seq?: number; // auto-increment: global FIFO order
  id: string;
  userId: string;
  promotionId: string;
  kind: OutboxKind;
  /** Request body, exactly as it will be sent (also reused verbatim on every retry). */
  payload: Record<string, unknown>;
  /** Fixed at creation; identical on every retry (server-side deduplication). */
  idempotencyKey: string;
  /** Local record this mutation materializes or acts on (customer key / order key). */
  localRef: string;
  /** Local records that must be successfully sent first (customer for an order, order for its actions). */
  deps?: string[];
  status: "pending" | "failed" | "conflict";
  attempts: number;
  nextAttemptAt: number; // epoch ms
  lastError: ProblemDetails | null;
  createdAt: string;
}

/** v1 order rows (Slice 4.2), migrated in version(2). */
interface LegacyOrderV1 {
  key: string;
  userId: string;
  promotionId: string;
  idempotencyKey: string;
  customerId: string;
  customerName: string;
  lines: LocalOrderLine[];
  markPaidNow: boolean;
  createdAt: string;
  sync: SyncState;
  serverId: string | null;
  serverVersion: number | null;
  serverTotal: string | null;
}

export class PromoLedgerDB extends Dexie {
  promotions!: EntityTable<CachedPromotion, "key">;
  products!: EntityTable<CachedProduct, "key">;
  customers!: EntityTable<CachedCustomer, "key">;
  orders!: EntityTable<CachedOrder, "key">;
  outbox!: EntityTable<OutboxItem, "seq">;

  constructor(name = "promoledger") {
    super(name);
    this.version(1).stores({
      promotions: "key, userId",
      products: "key, [userId+promotionId]",
      customers: "key, [userId+promotionId]",
      orders: "key, [userId+promotionId], idempotencyKey",
      outbox: "++seq, &id, userId, [userId+promotionId]",
    });
    // v2 (Slice 4.3): orders also cache server snapshots; look up by serverId.
    this.version(2)
      .stores({ orders: "key, [userId+promotionId], serverId" })
      .upgrade((tx) =>
        tx
          .table("orders")
          .toCollection()
          .modify((row: LegacyOrderV1 & Partial<CachedOrder>) => {
            row.ref = row.idempotencyKey;
            row.version = row.serverVersion ?? 1;
            row.total = row.serverTotal ?? null;
            row.paidAt = row.markPaidNow ? row.createdAt : null;
            row.deliveredAt = null;
            row.cancelledAt = null;
            row.auditEvents = null;
          }),
      );
  }
}

export const db = new PromoLedgerDB();

export const scopedKey = (...parts: string[]) => parts.join(":");
