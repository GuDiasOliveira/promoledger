/**
 * Offline-first mutations: each one writes the optimistic local record AND its outbox entry
 * in a single IndexedDB transaction, so they can never get out of sync.
 */
import {
  type CachedCustomer,
  type CachedOrder,
  type OutboxItem,
  type PromoLedgerDB,
  scopedKey,
  type TransitionKind,
} from "@/lib/db";
import {
  canApply,
  deriveOrder,
  ENDPOINT,
  type OrderState,
  planReapply,
  type ReapplyPlan,
  REASON_REQUIRED,
  transitionKind,
} from "@/lib/orders/state";

const uuid = () => crypto.randomUUID();

function outboxRow(
  fields: Pick<OutboxItem, "userId" | "promotionId" | "kind" | "payload" | "localRef"> &
    Partial<Pick<OutboxItem, "idempotencyKey" | "deps">>,
): OutboxItem {
  return {
    id: uuid(),
    idempotencyKey: uuid(),
    deps: [],
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    ...fields,
  };
}

export async function userQueue(db: PromoLedgerDB, userId: string): Promise<OutboxItem[]> {
  return db.outbox.where("userId").equals(userId).sortBy("seq");
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
  input: Pick<
    CachedOrder,
    "userId" | "promotionId" | "customerId" | "customerName" | "lines" | "markPaidNow"
  >,
): Promise<CachedOrder> {
  const idempotencyKey = uuid();
  const createdAt = new Date().toISOString();
  const order: CachedOrder = {
    ...input,
    key: scopedKey(input.userId, idempotencyKey),
    ref: idempotencyKey,
    serverId: null,
    version: 1, // every order starts at version 1 on the server
    paidAt: input.markPaidNow ? createdAt : null,
    deliveredAt: null,
    cancelledAt: null,
    total: null,
    createdAt,
    sync: "pending",
    auditEvents: null,
  };
  const customerKey = scopedKey(input.userId, input.promotionId, input.customerId);
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
        deps: [customerKey],
      }),
    );
  });
  return order;
}

export class TransitionNotAllowed extends Error {}

function transitionRow(
  order: CachedOrder,
  kind: TransitionKind,
  expectedVersion: number,
  reason: string | null,
): OutboxItem {
  return outboxRow({
    userId: order.userId,
    promotionId: order.promotionId,
    kind: "transition",
    // `kind` is local metadata; `body` is exactly what is sent.
    payload: {
      kind,
      body: {
        ...(ENDPOINT[kind].action ? { action: ENDPOINT[kind].action } : {}),
        expected_version: expectedVersion,
        ...(reason ? { reason } : {}),
      },
    },
    localRef: order.key,
    deps: [order.key],
  });
}

/**
 * Queue a lifecycle action. Works offline and even before the order itself was sent:
 * `expected_version` = known server version + actions already queued for this order.
 */
export async function enqueueTransition(
  db: PromoLedgerDB,
  orderKey: string,
  kind: TransitionKind,
  reason: string | null = null,
): Promise<void> {
  if (REASON_REQUIRED.has(kind) && !reason?.trim()) {
    throw new TransitionNotAllowed(`${kind} requires a reason`);
  }
  await db.transaction("rw", db.orders, db.outbox, async () => {
    const order = await db.orders.get(orderKey);
    if (!order) throw new TransitionNotAllowed("Unknown order");
    const derived = deriveOrder(order, await userQueue(db, order.userId));
    if (derived.needsResolution) throw new TransitionNotAllowed("Resolve the conflict first");
    if (!canApply(derived.state, kind)) throw new TransitionNotAllowed(`${kind} not allowed now`);
    await db.outbox.add(transitionRow(order, kind, derived.state.version, reason?.trim() || null));
  });
}

/** User action: drop a queued mutation, its optimistic record, and everything depending on it. */
export async function discardOutboxItem(db: PromoLedgerDB, item: OutboxItem): Promise<void> {
  await db.transaction("rw", db.outbox, db.orders, db.customers, async () => {
    const queue = await userQueue(db, item.userId);
    const dropped = new Set<string>();
    const toDelete: OutboxItem[] = [item];
    if (item.kind !== "transition") dropped.add(item.localRef);
    // Cascade: later items depending on a dropped record can never succeed, and later
    // actions on the same order were chained on a version that will now never exist.
    for (const other of queue) {
      const sameOrderChain =
        item.kind === "transition" && other.kind === "transition" && other.localRef === item.localRef;
      if (other.seq! > item.seq! && (sameOrderChain || (other.deps ?? []).some((d) => dropped.has(d)))) {
        toDelete.push(other);
        if (other.kind !== "transition") dropped.add(other.localRef);
      }
    }
    await db.outbox.bulkDelete(toDelete.map((i) => i.seq!));
    for (const ref of dropped) {
      await db.orders.delete(ref);
      await db.customers.delete(ref);
    }
  });
}

/** Mark the local record of a terminally-rejected creation, so lists can flag it. */
export async function markLocalRecord(
  db: PromoLedgerDB,
  item: OutboxItem,
  sync: "failed" | "conflict",
): Promise<void> {
  if (item.kind === "createOrder") await db.orders.update(item.localRef, { sync });
  if (item.kind === "createCustomer") await db.customers.update(item.localRef, { sync });
}

/**
 * Conflict resolution — "Reapply my actions": replace this order's queued actions with a
 * plan rebased on the CURRENT server state. Every action gets a NEW Idempotency-Key: one key
 * = one user decision. (The rejected request's key was never recorded server-side — the
 * whole transaction rolled back — so reusing it would also work; a fresh key just keeps
 * the audit trail unambiguous. Verified by a negative-control E2E run.)
 */
export async function reapplyOrderActions(
  db: PromoLedgerDB,
  orderKey: string,
  server: OrderState,
): Promise<ReapplyPlan> {
  return db.transaction("rw", db.orders, db.outbox, async () => {
    const order = await db.orders.get(orderKey);
    if (!order) throw new TransitionNotAllowed("Unknown order");
    const queue = await userQueue(db, order.userId);
    const mine = queue.filter((i) => i.kind === "transition" && i.localRef === orderKey);
    const plan = planReapply(
      server,
      mine.map((i) => ({
        kind: transitionKind(i),
        reason: ((i.payload.body as { reason?: string }).reason ?? null) as string | null,
      })),
      new Date().toISOString(),
    );
    await db.orders.update(orderKey, { ...server });
    await db.outbox.bulkDelete(mine.map((i) => i.seq!));
    const updated = { ...order, ...server };
    for (const step of plan.apply) {
      await db.outbox.add(transitionRow(updated, step.kind, step.expectedVersion, step.reason));
    }
    return plan;
  });
}

/** Conflict resolution — "Discard my actions": keep the server state as it is. */
export async function discardOrderActions(
  db: PromoLedgerDB,
  orderKey: string,
  server: OrderState,
): Promise<void> {
  await db.transaction("rw", db.orders, db.outbox, async () => {
    const order = await db.orders.get(orderKey);
    if (!order) return;
    const queue = await userQueue(db, order.userId);
    const mine = queue.filter((i) => i.kind === "transition" && i.localRef === orderKey);
    await db.outbox.bulkDelete(mine.map((i) => i.seq!));
    await db.orders.update(orderKey, { ...server });
  });
}
