/**
 * Server -> IndexedDB refreshers. The UI always reads from IndexedDB (works offline);
 * these pull fresh data whenever the network allows. Errors propagate to the caller
 * (React Query), which simply keeps the cached data when offline.
 */
import { api, unwrap } from "@/lib/api/client";
import { type CachedCustomer, type CachedProduct, type CachedPromotion, type PromoLedgerDB, scopedKey } from "@/lib/db";

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
        params: { path: { promotion_id: promotionId }, query: { page: pageNumber, size: PAGE_SIZE } },
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
        params: { path: { promotion_id: promotionId }, query: { page: pageNumber, size: PAGE_SIZE } },
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
