"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { type AdminScope, adminOrderHref, WithAdmin } from "@/components/admin/admin-scope";
import { ClassificationBadge } from "@/components/order-ui";
import { Button, Card, ErrorBanner, Field } from "@/components/ui";
import {
  CLASSIFICATIONS,
  type OrderFilters,
  orderFiltersQuery,
  parseOrderFilters,
  totalPages,
} from "@/lib/admin/filters";
import { PAGE_SIZE, useAdminOrders, useCustomerSearch, useMemberNames } from "@/lib/admin/queries";
import { formatDateTime } from "@/lib/format";
import { useErrorMessage } from "@/lib/hooks";
import { formatMoney, parseMoney } from "@/lib/money";

function CustomerFilter({
  promotionId,
  selectedName,
  onPick,
}: {
  promotionId: string;
  selectedName: string | null;
  onPick: (customer: { id: string; name: string } | null) => void;
}) {
  const t = useTranslations("admin.orders");
  const [q, setQ] = useState("");
  const results = useCustomerSearch(promotionId, q);
  if (selectedName) {
    return (
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("customer")}</span>
          <p className="py-3 font-medium">{selectedName}</p>
        </div>
        <Button variant="ghost" onClick={() => onPick(null)}>
          {t("clear")}
        </Button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Field label={t("customerSearch")} type="search" value={q} onChange={(e) => setQ(e.target.value)} />
      {results.data && results.data.items.length > 0 ? (
        <ul className="absolute z-10 mt-1 w-full rounded-lg border border-zinc-200 bg-white shadow dark:border-zinc-800 dark:bg-zinc-900">
          {results.data.items.map((c) => (
            <li key={c.id}>
              <button type="button" className="w-full px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => onPick(c)}>
                {c.name} <span className="text-sm text-zinc-500">{c.contact}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Orders({ promotion }: AdminScope) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const filters = parseOrderFilters(useSearchParams());
  const orders = useAdminOrders(promotion.id, filters);
  const names = useMemberNames(promotion.id);

  const go = (next: Partial<OrderFilters>) => {
    const merged = { ...filters, page: 1, ...next };
    router.replace(`/promotion/admin/orders?${orderFiltersQuery(promotion.id, merged)}`);
  };
  const money = (amount: string) => formatMoney(parseMoney(amount), promotion.currency, locale);
  const pages = totalPages(orders.data?.total ?? 0, PAGE_SIZE);
  const select =
    "w-full rounded-lg border border-zinc-300 bg-white px-3 py-3 dark:border-zinc-700 dark:bg-zinc-950";

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t("admin.orders.title")}</h1>
      <Card>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="block space-y-1">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("admin.orders.status")}</span>
            <select
              className={select}
              value={filters.classification ?? ""}
              onChange={(e) => go({ classification: (e.target.value || null) as OrderFilters["classification"] })}
            >
              <option value="">{t("admin.orders.any")}</option>
              {CLASSIFICATIONS.map((c) => (
                <option key={c} value={c}>
                  {t(`orders.classification.${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("admin.orders.seller")}</span>
            <select
              className={select}
              value={filters.sellerMemberId ?? ""}
              onChange={(e) => go({ sellerMemberId: e.target.value || null })}
            >
              <option value="">{t("admin.orders.any")}</option>
              {[...(names.data ?? new Map<string, string>()).entries()]
                .sort((a, b) => a[1].localeCompare(b[1], locale))
                .map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
            </select>
          </label>
          <CustomerFilter
            promotionId={promotion.id}
            selectedName={filters.customerId ? (filters.customerName ?? "…") : null}
            onPick={(c) => go({ customerId: c?.id ?? null, customerName: c?.name ?? null })}
          />
        </div>
      </Card>

      {orders.isError ? <ErrorBanner message={errorMessage(orders.error)} /> : null}
      <Card>
        {!orders.data ? (
          <p>{t("common.loading")}</p>
        ) : orders.data.items.length === 0 ? (
          <p className="text-zinc-500">{t("admin.orders.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm" data-testid="admin-orders">
              <thead className="text-left text-zinc-500">
                <tr>
                  <th className="py-2">{t("admin.col.customer")}</th>
                  <th>{t("admin.col.seller")}</th>
                  <th>{t("admin.col.status")}</th>
                  <th className="text-right">{t("admin.col.total")}</th>
                  <th className="text-right">{t("admin.col.date")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {orders.data.items.map((o) => (
                  <tr key={o.id}>
                    <td className="py-2">
                      <Link href={adminOrderHref(promotion.id, o.id)} className="font-medium text-indigo-600">
                        {o.customer.name}
                      </Link>
                    </td>
                    <td>{names.data?.get(o.seller_member_id) ?? "…"}</td>
                    <td>
                      <ClassificationBadge value={o.status_classification} />
                    </td>
                    <td className="text-right tabular-nums">{money(o.total_amount)}</td>
                    <td className="text-right text-zinc-500">{formatDateTime(o.created_at, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex items-center justify-between gap-2 text-sm">
          <Button variant="ghost" disabled={filters.page <= 1} onClick={() => go({ page: filters.page - 1 })}>
            ← {t("admin.orders.prev")}
          </Button>
          <span>{t("admin.orders.page", { page: filters.page, pages })}</span>
          <Button variant="ghost" disabled={filters.page >= pages} onClick={() => go({ page: filters.page + 1 })}>
            {t("admin.orders.next")} →
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default function AdminOrdersPage() {
  return <WithAdmin>{(scope) => <Orders {...scope} />}</WithAdmin>;
}
