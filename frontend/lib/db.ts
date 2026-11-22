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
  unitPrice: string; // catalog price at capture time (display estimate; server snapshot wins)
}

export interface LocalOrder {
  key: string; // `${userId}:${idempotencyKey}`
  userId: string;
  promotionId: string;
  idempotencyKey: string;
  customerId: string;
  customerName: string;
  lines: LocalOrderLine[];
  markPaidNow: boolean;
  createdAt: string; // ISO instant (device clock)
  sync: SyncState;
  serverId: string | null;
  serverVersion: number | null;
  serverTotal: string | null; // authoritative total once synced
}

export type OutboxKind = "createCustomer" | "createOrder";

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
  /** Local record this mutation materializes (customer id / order key). */
  localRef: string;
  status: "pending" | "failed" | "conflict";
  attempts: number;
  nextAttemptAt: number; // epoch ms
  lastError: ProblemDetails | null;
  createdAt: string;
}

export class PromoLedgerDB extends Dexie {
  promotions!: EntityTable<CachedPromotion, "key">;
  products!: EntityTable<CachedProduct, "key">;
  customers!: EntityTable<CachedCustomer, "key">;
  orders!: EntityTable<LocalOrder, "key">;
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
  }
}

export const db = new PromoLedgerDB();

export const scopedKey = (...parts: string[]) => parts.join(":");
