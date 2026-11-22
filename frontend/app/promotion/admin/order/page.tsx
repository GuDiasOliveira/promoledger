"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

import { type AdminScope, WithAdmin } from "@/components/admin/admin-scope";
import { ClassificationBadge } from "@/components/order-ui";
import { Button, Card, ErrorBanner, Field } from "@/components/ui";
import { runAdminTransition, useAdminOrder, useMemberNames } from "@/lib/admin/queries";
import { ApiError } from "@/lib/api/errors";
import type { TransitionKind } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { useErrorMessage } from "@/lib/hooks";
import { formatMoney, parseMoney } from "@/lib/money";
import { canApply, REASON_REQUIRED, TRANSITIONS } from "@/lib/orders/state";

function AdminOrder({ promotion, isAdmin }: AdminScope) {
  const t = useTranslations();
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const orderId = useSearchParams().get("order");
  const order = useAdminOrder(promotion.id, orderId);
  const names = useMemberNames(promotion.id);
  const [reasonFor, setReasonFor] = useState<TransitionKind | null>(null);
  const [reason, setReason] = useState("");
  const [conflict, setConflict] = useState(false);

  const act = useMutation({
    mutationFn: ({ kind, why }: { kind: TransitionKind; why: string | null }) =>
      runAdminTransition(promotion.id, orderId!, kind, order.data!.version, why),
    onMutate: () => setConflict(false),
    onSuccess: (updated) => {
      setReasonFor(null);
      setReason("");
      queryClient.setQueryData(["admin", promotion.id, "order", orderId], updated);
      // Totals, divergences, ranking and lists all depend on this order.
      void queryClient.invalidateQueries({ queryKey: ["admin", promotion.id], refetchType: "none" });
    },
    onError: (error) => {
      // Decision 2 (Slice 4.4): no blind retry — reload the current state and let the admin decide.
      if (error instanceof ApiError && error.code === "CONCURRENCY_CONFLICT") {
        setConflict(true);
        void order.refetch();
      }
    },
  });

  if (order.isError) return <ErrorBanner message={errorMessage(order.error)} />;
  if (!order.data) return <p>{t("common.loading")}</p>;
  const o = order.data;
  const state = {
    version: o.version,
    paidAt: o.paid_at ?? null,
    deliveredAt: o.delivered_at ?? null,
    cancelledAt: o.cancelled_at ?? null,
  };
  const money = (amount: string) => formatMoney(parseMoney(amount), promotion.currency, locale);
  const name = (memberId: string) => names.data?.get(memberId) ?? "…";

  const submitReason = (event: FormEvent) => {
    event.preventDefault();
    act.mutate({ kind: reasonFor!, why: reason.trim() });
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card>
          <div className="flex items-start justify-between gap-2">
            <h1 className="text-xl font-semibold">{t("order.title", { name: o.customer.name })}</h1>
            <span data-testid="admin-order-status">
              <ClassificationBadge value={o.status_classification} />
            </span>
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            {t("admin.order.seller")}: {name(o.seller_member_id)} ·{" "}
            {t("order.placedAt", { date: formatDateTime(o.created_at, locale) })}
          </p>
          <ul className="mt-4 divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            {o.items.map((item) => (
              <li key={item.id} className="flex justify-between gap-2 py-2">
                <span>
                  {item.quantity} × {item.product_name}
                </span>
                <span className="tabular-nums">{money(item.line_total)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-between font-semibold">
            <span>{t("order.total")}</span>
            <span className="tabular-nums">{money(o.total_amount)}</span>
          </div>
        </Card>

        <Card>
          <h2 className="mb-2 font-semibold">{t("order.history")}</h2>
          <ol className="space-y-2 text-sm" data-testid="history">
            {o.audit_events.map((e) => (
              <li key={e.id} className="flex flex-wrap justify-between gap-2">
                <span>
                  {t(`order.events.${e.event_type}`)} · {name(e.actor_member_id)}
                  {e.reason ? <span className="text-zinc-500"> — {e.reason}</span> : null}
                </span>
                <span className="text-zinc-500">{formatDateTime(e.created_at, locale)}</span>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      {isAdmin ? (
        <Card>
          <div className="space-y-3">
            {conflict ? (
              <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                {t("admin.order.conflict")}
              </p>
            ) : act.isError ? (
              <ErrorBanner message={errorMessage(act.error)} />
            ) : null}
            {reasonFor ? (
              <form onSubmit={submitReason} className="space-y-3" aria-label={t(`order.actions.${reasonFor}`)}>
                <p className="font-medium">{t(`order.actions.${reasonFor}`)}</p>
                <Field label={t("order.reason")} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                <div className="flex gap-2">
                  <Button type="submit" disabled={!reason.trim() || act.isPending}>
                    {t("order.confirm")}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setReasonFor(null)}>
                    {t("order.back")}
                  </Button>
                </div>
              </form>
            ) : (
              TRANSITIONS.filter((kind) => canApply(state, kind)).map((kind) => (
                <Button
                  key={kind}
                  className="w-full"
                  variant={kind === "MARK_PAID" || kind === "MARK_DELIVERED" ? "primary" : "ghost"}
                  disabled={act.isPending}
                  onClick={() => (REASON_REQUIRED.has(kind) ? setReasonFor(kind) : act.mutate({ kind, why: null }))}
                >
                  {t(`order.actions.${kind}`)}
                </Button>
              ))
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

export default function AdminOrderPage() {
  return <WithAdmin>{(scope) => <AdminOrder {...scope} />}</WithAdmin>;
}
