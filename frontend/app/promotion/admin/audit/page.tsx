"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { type AdminScope, adminOrderHref, WithAdmin } from "@/components/admin/admin-scope";
import { Button, Card, ErrorBanner } from "@/components/ui";
import { totalPages } from "@/lib/admin/filters";
import { PAGE_SIZE, useAuditEvents, useMemberNames } from "@/lib/admin/queries";
import { formatDateTime } from "@/lib/format";
import { useErrorMessage } from "@/lib/hooks";

const EVENT_TYPES = ["PAYMENT_MARKED", "PAYMENT_REVOKED", "DELIVERY_MARKED", "DELIVERY_REVOKED", "ORDER_CANCELLED"] as const;

function Audit({ promotion }: AdminScope) {
  const t = useTranslations();
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const [page, setPage] = useState(1);
  const [eventType, setEventType] = useState<string | null>(null);
  const events = useAuditEvents(promotion.id, page, eventType);
  const names = useMemberNames(promotion.id);
  const pages = totalPages(events.data?.total ?? 0, PAGE_SIZE);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t("admin.nav.audit")}</h1>
      <select
        aria-label={t("admin.col.event")}
        className="rounded-lg border border-zinc-300 bg-white px-3 py-3 dark:border-zinc-700 dark:bg-zinc-950"
        value={eventType ?? ""}
        onChange={(e) => {
          setEventType(e.target.value || null);
          setPage(1);
        }}
      >
        <option value="">{t("admin.audit.anyEvent")}</option>
        {EVENT_TYPES.map((type) => (
          <option key={type} value={type}>
            {t(`order.events.${type}`)}
          </option>
        ))}
      </select>
      {events.isError ? <ErrorBanner message={errorMessage(events.error)} /> : null}
      <Card>
        {!events.data ? (
          <p>{t("common.loading")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm" data-testid="audit">
              <thead className="text-left text-zinc-500">
                <tr>
                  <th className="py-2">{t("admin.col.date")}</th>
                  <th>{t("admin.col.event")}</th>
                  <th>{t("admin.col.actor")}</th>
                  <th>{t("admin.col.reason")}</th>
                  <th>{t("admin.col.order")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {events.data.items.map((e) => (
                  <tr key={e.id}>
                    <td className="py-2 text-zinc-500">{formatDateTime(e.created_at, locale)}</td>
                    <td>{t(`order.events.${e.event_type}`)}</td>
                    <td>{names.data?.get(e.actor_member_id) ?? "…"}</td>
                    <td className="text-zinc-600 dark:text-zinc-400">{e.reason ?? "—"}</td>
                    <td>
                      <Link href={adminOrderHref(promotion.id, e.order_id)} className="text-indigo-600">
                        {t("admin.order.open")}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex items-center justify-between gap-2 text-sm">
          <Button variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ← {t("admin.orders.prev")}
          </Button>
          <span>{t("admin.orders.page", { page, pages })}</span>
          <Button variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            {t("admin.orders.next")} →
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default function AdminAuditPage() {
  return <WithAdmin adminOnly>{(scope) => <Audit {...scope} />}</WithAdmin>;
}
