"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { ClassificationBadge } from "@/components/order-ui";
import {
  orderHref,
  type PromotionScope,
  promotionHref,
  WithPromotion,
} from "@/components/promotion-scope";
import { Badge, Card, Field } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { useOrders } from "@/lib/offline/hooks";
import { type Classification, classify, type DerivedOrder } from "@/lib/orders/state";
import { orderTotalCents } from "@/lib/orders/total";

const TABS = {
  all: () => true,
  toDeliver: (c: Classification) => c === "PAID_PENDING",
  unpaid: (c: Classification) => c === "UNPAID_PENDING",
  divergence: (c: Classification) => c === "DIVERGENCE",
  done: (c: Classification) => c === "SETTLED" || c === "CANCELLED",
} as const;
type Tab = keyof typeof TABS;

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

function OrderCard({
  derived,
  promotionId,
  currency,
}: {
  derived: DerivedOrder;
  promotionId: string;
  currency: string;
}) {
  const t = useTranslations("orders");
  const locale = useLocale();
  const { order } = derived;
  const unsent = order.sync === "pending" || derived.pending.length > 0;
  return (
    <li>
      <Link
        href={orderHref(promotionId, order.ref)}
        data-testid="order-card"
        className="block rounded-xl border border-zinc-200 p-4 hover:border-indigo-400 dark:border-zinc-800"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="font-medium">{order.customerName}</span>
          <span className="tabular-nums font-semibold">
            {formatMoney(orderTotalCents(derived), currency, locale)}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-zinc-500">
          <ClassificationBadge value={classify(derived.state)} />
          {derived.needsResolution || order.sync === "failed" || order.sync === "conflict" ? (
            <Badge tone="amber">{t("needsAttention")}</Badge>
          ) : unsent ? (
            <Badge>{t("pendingSync")}</Badge>
          ) : null}
          <span className="ml-auto">{formatDateTime(order.createdAt, locale)}</span>
        </div>
      </Link>
    </li>
  );
}

function OrdersList({ userId, promotion }: PromotionScope) {
  const t = useTranslations();
  const orders = useOrders(userId, promotion.id);
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = fold(query.trim());
    return (orders ?? []).filter(
      (d) => TABS[tab](classify(d.state)) && (!q || fold(d.order.customerName).includes(q)),
    );
  }, [orders, tab, query]);

  return (
    <div className="space-y-4">
      <Link href={promotionHref("", promotion.id)} className="text-sm text-indigo-600">
        ← {promotion.name}
      </Link>
      <h1 className="text-xl font-semibold">{t("orders.title")}</h1>
      <div role="tablist" className="flex gap-1 overflow-x-auto pb-1">
        {(Object.keys(TABS) as Tab[]).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`min-h-11 shrink-0 rounded-full px-4 text-sm font-medium ${
              tab === key
                ? "bg-indigo-600 text-white"
                : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            {t(`orders.tabs.${key}`)}
          </button>
        ))}
      </div>
      <Field
        label={t("orders.search")}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {orders === undefined ? (
        <p>{t("common.loading")}</p>
      ) : visible.length === 0 ? (
        <Card>
          <p className="text-zinc-600 dark:text-zinc-400">{t("orders.empty")}</p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {visible.map((d) => (
            <OrderCard
              key={d.order.key}
              derived={d}
              promotionId={promotion.id}
              currency={promotion.currency}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export default function OrdersPage() {
  return <WithPromotion>{(scope) => <OrdersList {...scope} />}</WithPromotion>;
}
