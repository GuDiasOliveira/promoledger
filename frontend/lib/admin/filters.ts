/**
 * Admin order filters live in the URL (shareable, survive reloads). Pure helpers, so the
 * parsing rules are unit-tested and the pages stay thin.
 */
export const CLASSIFICATIONS = [
  "UNPAID_PENDING",
  "PAID_PENDING",
  "DIVERGENCE",
  "SETTLED",
  "CANCELLED",
] as const;
export type ClassificationFilter = (typeof CLASSIFICATIONS)[number];

export interface OrderFilters {
  classification: ClassificationFilter | null;
  sellerMemberId: string | null;
  customerId: string | null;
  /** Display-only label for the customer filter (there is no "customer by id" endpoint). */
  customerName: string | null;
  page: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (value: string | null) => (value && UUID_RE.test(value) ? value : null);

export function parseOrderFilters(params: URLSearchParams): OrderFilters {
  const classification = params.get("status");
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  return {
    classification: (CLASSIFICATIONS as readonly string[]).includes(classification ?? "")
      ? (classification as ClassificationFilter)
      : null,
    sellerMemberId: uuidOrNull(params.get("seller")),
    customerId: uuidOrNull(params.get("customer")),
    customerName: uuidOrNull(params.get("customer"))
      ? (params.get("customerName")?.slice(0, 255) ?? null)
      : null,
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}

/** Serialize back, always keeping the promotion `id`. Changing a filter resets the page. */
export function orderFiltersQuery(promotionId: string, filters: OrderFilters): string {
  const params = new URLSearchParams({ id: promotionId });
  if (filters.classification) params.set("status", filters.classification);
  if (filters.sellerMemberId) params.set("seller", filters.sellerMemberId);
  if (filters.customerId) {
    params.set("customer", filters.customerId);
    if (filters.customerName) params.set("customerName", filters.customerName);
  }
  if (filters.page > 1) params.set("page", String(filters.page));
  return params.toString();
}

/** API query parameters for GET /orders. */
export function orderFiltersToApi(filters: OrderFilters, size: number) {
  return {
    page: filters.page,
    size,
    ...(filters.classification ? { status_classification: filters.classification } : {}),
    ...(filters.sellerMemberId ? { seller_member_id: filters.sellerMemberId } : {}),
    ...(filters.customerId ? { customer_id: filters.customerId } : {}),
  };
}

export const totalPages = (total: number, size: number) => Math.max(1, Math.ceil(total / size));
