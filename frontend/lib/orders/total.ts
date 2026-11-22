import { lineTotal, parseMoney, sumMoney } from "@/lib/money";

import type { DerivedOrder } from "./state";

/** Server total when known; otherwise the local estimate (exact bigint arithmetic). */
export function orderTotalCents(d: Pick<DerivedOrder, "order">): bigint {
  if (d.order.total) return parseMoney(d.order.total);
  return sumMoney(d.order.lines.map((l) => lineTotal(parseMoney(l.unitPrice), l.quantity)));
}
