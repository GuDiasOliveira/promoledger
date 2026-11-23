/** Real sender: maps each outbox item to its API call and applies the server result locally. */
import { api, type Schemas, unwrap } from "@/lib/api/client";
import { toApiError } from "@/lib/api/errors";
import type { CachedOrder, OutboxItem, PromoLedgerDB, TransitionKind } from "@/lib/db";
import { ENDPOINT } from "@/lib/orders/state";

import type { Sender } from "./engine";

type ServerOrder = Schemas["OrderResponse"] | Schemas["OrderDetailResponse"];

/** Server order -> the snapshot fields of a CachedOrder (server is the source of truth). */
export function snapshotFromServer(order: ServerOrder): Partial<CachedOrder> {
  return {
    serverId: order.id,
    version: order.version,
    customerId: order.customer.id,
    customerName: order.customer.name,
    lines: order.items.map((item) => ({
      productId: item.product_id,
      name: item.product_name,
      quantity: item.quantity,
      unitPrice: item.unit_price,
    })),
    paidAt: order.paid_at ?? null,
    deliveredAt: order.delivered_at ?? null,
    cancelledAt: order.cancelled_at ?? null,
    total: order.total_amount,
    sync: "synced",
    ...("audit_events" in order
      ? {
          auditEvents: order.audit_events.map((e) => ({
            id: e.id,
            eventType: e.event_type,
            reason: e.reason ?? null,
            createdAt: e.created_at,
          })),
        }
      : {}),
  };
}

/** Server lines win; a local name is only a fallback if the server sent none. */
export function mergeLines(current: CachedOrder | undefined, incoming: Partial<CachedOrder>) {
  const names = new Map((current?.lines ?? []).map((l) => [l.productId, l.name]));
  return (incoming.lines ?? []).map((l) => ({
    ...l,
    name: l.name || names.get(l.productId) || "",
  }));
}

export async function applyServerOrder(db: PromoLedgerDB, key: string, order: ServerOrder) {
  const current = await db.orders.get(key);
  const snapshot = snapshotFromServer(order);
  await db.orders.update(key, { ...snapshot, lines: mergeLines(current, snapshot) });
}

export function apiSender(db: PromoLedgerDB): Sender {
  return async (item: OutboxItem) => {
    const path = { promotion_id: item.promotionId };
    switch (item.kind) {
      case "createCustomer": {
        await unwrap(
          api.POST("/api/v1/promotions/{promotion_id}/customers", {
            params: { path },
            body: item.payload as { id: string; name: string; contact: string | null },
          }),
        );
        await db.customers.update(item.localRef, { sync: "synced" });
        return;
      }
      case "createOrder": {
        const order = await unwrap(
          api.POST("/api/v1/promotions/{promotion_id}/orders", {
            params: { path, header: { "Idempotency-Key": item.idempotencyKey } },
            body: item.payload as {
              customer_id: string;
              items: { product_id: string; quantity: number }[];
              mark_paid_now: boolean;
            },
          }),
        );
        await applyServerOrder(db, item.localRef, order);
        return;
      }
      case "transition": {
        const local = await db.orders.get(item.localRef);
        if (!local?.serverId) {
          // Unreachable in practice: FIFO + deps guarantee the creation was sent first.
          throw toApiError(409, {
            status: 409,
            code: "ORDER_NOT_SYNCED",
            detail: "Order not sent yet",
          });
        }
        const kind = item.payload.kind as TransitionKind;
        const params = {
          path: { ...path, order_id: local.serverId },
          header: { "Idempotency-Key": item.idempotencyKey },
        };
        const body = item.payload.body as never;
        const endpoint = ENDPOINT[kind].path;
        const order = await unwrap(
          endpoint === "payment"
            ? api.POST("/api/v1/promotions/{promotion_id}/orders/{order_id}/payment", {
                params,
                body,
              })
            : endpoint === "delivery"
              ? api.POST("/api/v1/promotions/{promotion_id}/orders/{order_id}/delivery", {
                  params,
                  body,
                })
              : api.POST("/api/v1/promotions/{promotion_id}/orders/{order_id}/cancel", {
                  params,
                  body,
                }),
        );
        await applyServerOrder(db, item.localRef, order);
        return;
      }
    }
  };
}
