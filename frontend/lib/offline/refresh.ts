/**
 * Server -> IndexedDB refreshers. The UI always reads from IndexedDB (works offline);
 * these pull fresh data whenever the network allows. Errors propagate to the caller
 * (React Query), which simply keeps the cached data when offline.
 */
import { api, type Schemas, unwrap } from "@/lib/api/client";
import {
  type CachedCustomer,
  type CachedOrder,
  type CachedProduct,
  type CachedPromotion,
  type PromoLedgerDB,
  scopedKey,
} from "@/lib/db";
import { applyServerOrder, mergeLines, snapshotFromServer } from "@/lib/sync/send";

const PAGE_SIZE = 100;
const MAX_CUSTOMER_PAGES = 5; // up to 500 customers cached per promotion (MVP)

export async function refreshPromotions(db: PromoLedgerDB, userId: string): Promise<void> {
  const [me, page] = await Promise.all([
    unwrap(api.GET("/api/v1/auth/me")),
    unwrap(api.GET("/api/v1/promotions", { params: { query: { page: 1, size: PAGE_SIZE } } })),
  ]);
  const memberships = new Map(me.memberships.map((m) => [m.promotion_id, m]));
  const rows: CachedPromotion[] = page.items.flatMap((p) => {
    const membership = memberships.get(p.id);
    if (!membership) return [];
    return [
      {
        key: scopedKey(userId, p.id),
        userId,
        id: p.id,
        name: p.name,
        status: p.status,
        currency: p.currency,
        salesStartDate: p.sales_start_date,
        lastSalesDate: p.last_sales_date,
        deliveryDate: p.delivery_date,
        roles: membership.roles,
        memberId: membership.member_id,
      },
    ];
  });
  await db.transaction("rw", db.promotions, async () => {
    // Replace this user's list: memberships may have been revoked.
    await db.promotions.where("userId").equals(userId).delete();
    await db.promotions.bulkPut(rows);
  });
}

export async function refreshCatalog(
  db: PromoLedgerDB,
  userId: string,
  promotionId: string,
): Promise<void> {
  const rows: CachedProduct[] = [];
  for (let pageNumber = 1; ; pageNumber += 1) {
    const page = await unwrap(
      api.GET("/api/v1/promotions/{promotion_id}/products", {
        params: {
          path: { promotion_id: promotionId },
          query: { page: pageNumber, size: PAGE_SIZE },
        },
      }),
    );
    for (const p of page.items) {
      rows.push({
        key: scopedKey(userId, promotionId, p.id),
        userId,
        promotionId,
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.price,
      });
    }
    if (pageNumber * PAGE_SIZE >= page.total) break;
  }
  await db.transaction("rw", db.products, async () => {
    // Replace: archived products must disappear from the offline catalog.
    await db.products.where("[userId+promotionId]").equals([userId, promotionId]).delete();
    await db.products.bulkPut(rows);
  });
}

export async function refreshCustomers(
  db: PromoLedgerDB,
  userId: string,
  promotionId: string,
): Promise<void> {
  const rows: CachedCustomer[] = [];
  for (let pageNumber = 1; pageNumber <= MAX_CUSTOMER_PAGES; pageNumber += 1) {
    const page = await unwrap(
      api.GET("/api/v1/promotions/{promotion_id}/customers", {
        params: {
          path: { promotion_id: promotionId },
          query: { page: pageNumber, size: PAGE_SIZE },
        },
      }),
    );
    for (const c of page.items) {
      rows.push({
        key: scopedKey(userId, promotionId, c.id),
        userId,
        promotionId,
        id: c.id,
        name: c.name,
        contact: c.contact,
        sync: "synced",
      });
    }
    if (pageNumber * PAGE_SIZE >= page.total) break;
  }
  // Upsert only: customers created offline (still pending) must be kept.
  await db.customers.bulkPut(rows);
}

const MAX_ORDER_PAGES = 5; // up to 500 orders cached per promotion (MVP)

/**
 * Pull the seller's orders (the API already limits sellers to their own). Rows created on
 * this device are matched by serverId; a server snapshot never overwrites a newer one.
 */
export async function refreshOrders(
  db: PromoLedgerDB,
  userId: string,
  promotionId: string,
): Promise<void> {
  const serverOrders: Schemas["OrderResponse"][] = [];
  for (let pageNumber = 1; pageNumber <= MAX_ORDER_PAGES; pageNumber += 1) {
    const page = await unwrap(
      api.GET("/api/v1/promotions/{promotion_id}/orders", {
        params: {
          path: { promotion_id: promotionId },
          query: { page: pageNumber, size: PAGE_SIZE },
        },
      }),
    );
    serverOrders.push(...page.items);
    if (pageNumber * PAGE_SIZE >= page.total) break;
  }
  await db.transaction("rw", db.orders, async () => {
    for (const order of serverOrders) {
      const existing = (await db.orders.where("serverId").equals(order.id).toArray()).find(
        (row) => row.userId === userId,
      );
      const snapshot = snapshotFromServer(order);
      if (existing) {
        if (order.version >= existing.version) {
          await db.orders.update(existing.key, {
            ...snapshot,
            lines: mergeLines(existing, snapshot),
          });
        }
        continue;
      }
      const ref = `srv:${order.id}`;
      await db.orders.put({
        ...snapshot,
        key: scopedKey(userId, ref),
        ref,
        userId,
        promotionId,
        markPaidNow: false,
        createdAt: order.created_at,
        auditEvents: snapshot.auditEvents ?? null,
      } as CachedOrder);
    }
  });
}

/** Fetch one order with its audit history (online), storing it as the latest snapshot. */
export async function fetchOrderDetail(
  db: PromoLedgerDB,
  key: string,
  promotionId: string,
  serverId: string,
) {
  const order = await unwrap(
    api.GET("/api/v1/promotions/{promotion_id}/orders/{order_id}", {
      params: { path: { promotion_id: promotionId, order_id: serverId } },
    }),
  );
  const current = await db.orders.get(key);
  if (!current || order.version >= current.version) await applyServerOrder(db, key, order);
  return order;
}
