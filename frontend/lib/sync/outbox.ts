/**
 * Offline-first mutations: each one writes the optimistic local record AND its outbox entry
 * in a single IndexedDB transaction, so they can never get out of sync.
 */
import { type CachedCustomer, type LocalOrder, type OutboxItem, type PromoLedgerDB, scopedKey } from "@/lib/db";

const uuid = () => crypto.randomUUID();

function outboxRow(
  fields: Pick<OutboxItem, "userId" | "promotionId" | "kind" | "payload" | "localRef"> &
    Partial<Pick<OutboxItem, "idempotencyKey">>,
): OutboxItem {
  return {
    id: uuid(),
    idempotencyKey: uuid(),
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    ...fields,
  };
}

export async function createCustomerOffline(
  db: PromoLedgerDB,
  input: { userId: string; promotionId: string; name: string; contact: string | null },
): Promise<CachedCustomer> {
  // Client-generated id: the queued order can reference this customer before either syncs,
  // and re-sending the same id is idempotent on the server (docs/api.md §6).
  const id = uuid();
  const customer: CachedCustomer = {
    key: scopedKey(input.userId, input.promotionId, id),
    userId: input.userId,
    promotionId: input.promotionId,
    id,
    name: input.name,
    contact: input.contact,
    sync: "pending",
  };
  await db.transaction("rw", db.customers, db.outbox, async () => {
    await db.customers.put(customer);
    await db.outbox.add(
      outboxRow({
        userId: input.userId,
        promotionId: input.promotionId,
        kind: "createCustomer",
        payload: { id, name: input.name, contact: input.contact },
        localRef: customer.key,
        idempotencyKey: id,
      }),
    );
  });
  return customer;
}

export async function createOrderOffline(
  db: PromoLedgerDB,
  input: Omit<LocalOrder, "key" | "idempotencyKey" | "createdAt" | "sync" | "serverId" | "serverVersion" | "serverTotal">,
): Promise<LocalOrder> {
  const idempotencyKey = uuid();
  const order: LocalOrder = {
    ...input,
    key: scopedKey(input.userId, idempotencyKey),
    idempotencyKey,
    createdAt: new Date().toISOString(),
    sync: "pending",
    serverId: null,
    serverVersion: null,
    serverTotal: null,
  };
  await db.transaction("rw", db.orders, db.outbox, async () => {
    await db.orders.put(order);
    await db.outbox.add(
      outboxRow({
        userId: input.userId,
        promotionId: input.promotionId,
        kind: "createOrder",
        payload: {
          customer_id: input.customerId,
          items: input.lines.map((l) => ({ product_id: l.productId, quantity: l.quantity })),
          mark_paid_now: input.markPaidNow,
        },
        localRef: order.key,
        idempotencyKey,
      }),
    );
  });
  return order;
}

/** User action: drop a queued mutation and the optimistic record it would have created. */
export async function discardOutboxItem(db: PromoLedgerDB, item: OutboxItem): Promise<void> {
  await db.transaction("rw", db.outbox, db.orders, db.customers, async () => {
    await db.outbox.delete(item.seq!);
    if (item.kind === "createOrder") await db.orders.delete(item.localRef);
    if (item.kind === "createCustomer") await db.customers.delete(item.localRef);
  });
}

/** Mark the local record of a terminally-rejected item, so lists can flag it. */
export async function markLocalRecord(
  db: PromoLedgerDB,
  item: OutboxItem,
  sync: "failed" | "conflict",
): Promise<void> {
  if (item.kind === "createOrder") await db.orders.update(item.localRef, { sync });
  if (item.kind === "createCustomer") await db.customers.update(item.localRef, { sync });
}
