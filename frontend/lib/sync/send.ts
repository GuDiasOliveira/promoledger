/** Real sender: maps each outbox item to its API call and applies the server result locally. */
import { api, unwrap } from "@/lib/api/client";
import type { OutboxItem, PromoLedgerDB } from "@/lib/db";

import type { Sender } from "./engine";

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
        await db.orders.update(item.localRef, {
          sync: "synced",
          serverId: order.id,
          serverVersion: order.version,
          serverTotal: order.total_amount,
        });
        return;
      }
    }
  };
}
