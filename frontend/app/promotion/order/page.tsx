"use client";

import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

import { ClassificationBadge } from "@/components/order-ui";
import { type PromotionScope, promotionHref, WithPromotion } from "@/components/promotion-scope";
import { Badge, Button, Card, ErrorBanner, Field } from "@/components/ui";
import { ApiError } from "@/lib/api/errors";
import { db, type OutboxItem, scopedKey, type TransitionKind } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { useErrorMessage } from "@/lib/hooks";
import { formatMoney, lineTotal, parseMoney } from "@/lib/money";
import { useOnline, useOrder } from "@/lib/offline/hooks";
import { fetchOrderDetail } from "@/lib/offline/refresh";
import {
  canApply,
  classify,
  type DerivedOrder,
  type OrderState,
  planReapply,
  REASON_REQUIRED,
  TRANSITIONS,
  transitionKind,
} from "@/lib/orders/state";
import { orderTotalCents } from "@/lib/orders/total";
import { discardOrderActions, enqueueTransition, reapplyOrderActions } from "@/lib/sync/outbox";
import { requestSync } from "@/lib/sync/runner";

type Derived = DerivedOrder & { actions: OutboxItem[] };

function ActionButtons({ derived }: { derived: Derived }) {
  const t = useTranslations("order");
  const [reasonFor, setReasonFor] = useState<TransitionKind | null>(null);
  const [reason, setReason] = useState("");

  const run = async (kind: TransitionKind, why: string | null) => {
    await enqueueTransition(db, derived.order.key, kind, why);
    setReasonFor(null);
    setReason("");
    requestSync();
  };

  if (reasonFor) {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      void run(reasonFor, reason);
    };
    return (
      <form onSubmit={submit} className="space-y-3" aria-label={t(`actions.${reasonFor}`)}>
        <p className="font-medium">{t(`actions.${reasonFor}`)}</p>
        <Field label={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        <div className="flex gap-2">
          <Button type="submit" disabled={!reason.trim()}>
            {t("confirm")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setReasonFor(null)}>
            {t("back")}
          </Button>
        </div>
      </form>
    );
  }

  const available = TRANSITIONS.filter((kind) => canApply(derived.state, kind));
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {available.map((kind) => {
        const primary = kind === "MARK_PAID" || kind === "MARK_DELIVERED";
        return (
          <Button
            key={kind}
            variant={primary ? "primary" : "ghost"}
            className={primary ? "min-h-14 text-lg" : "border border-zinc-300 dark:border-zinc-700"}
            onClick={() => (REASON_REQUIRED.has(kind) ? setReasonFor(kind) : void run(kind, null))}
          >
            {t(`actions.${kind}`)}
          </Button>
        );
      })}
    </div>
  );
}

function stateSummary(state: OrderState) {
  return <ClassificationBadge value={classify(state)} />;
}

/** Decision 2 (Slice 4.3): show the server truth and let the user reapply or discard. */
function ConflictResolution({ derived, promotionId }: { derived: Derived; promotionId: string }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const online = useOnline();
  const { order } = derived;
  const rejected = derived.actions.find((a) => a.status !== "pending");
  const server = useQuery({
    queryKey: ["order-server", order.key, order.serverId],
    queryFn: () => fetchOrderDetail(db, order.key, promotionId, order.serverId!),
    enabled: online && order.serverId !== null,
    retry: false,
  });

  const serverState: OrderState | null = server.data
    ? {
        version: server.data.version,
        paidAt: server.data.paid_at ?? null,
        deliveredAt: server.data.delivered_at ?? null,
        cancelledAt: server.data.cancelled_at ?? null,
      }
    : null;
  const mine = derived.actions.map((a) => ({
    kind: transitionKind(a),
    reason: ((a.payload.body as { reason?: string }).reason ?? null) as string | null,
  }));
  const plan = serverState ? planReapply(serverState, mine, new Date().toISOString()) : null;

  const reapply = async () => {
    await reapplyOrderActions(db, order.key, serverState!);
    requestSync();
  };
  const discard = async () => discardOrderActions(db, order.key, serverState!);

  const isConflict = rejected?.lastError?.code === "CONCURRENCY_CONFLICT";
  return (
    <Card>
      <div role="region" aria-label={t("conflict.title")} className="space-y-3">
        <h2 className="text-lg font-semibold text-amber-700 dark:text-amber-400">
          {isConflict ? t("conflict.title") : t("conflict.rejected")}
        </h2>
        {isConflict ? (
          <p className="text-sm">{t("conflict.explain")}</p>
        ) : rejected?.lastError ? (
          <ErrorBanner message={errorMessage(new ApiError(rejected.lastError))} />
        ) : null}
        <div className="text-sm">
          <span className="font-medium">{t("conflict.mine")}: </span>
          {mine.map((m) => t(`order.actions.${m.kind}`)).join(" → ")}
        </div>
        {!online ? (
          <p className="text-sm text-zinc-600">{t("conflict.offline")}</p>
        ) : !serverState ? (
          <p>{t("common.loading")}</p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">{t("conflict.server")}:</span> {stateSummary(serverState)}
            </div>
            {plan!.apply.length === 0 ? (
              <p className="font-medium" data-testid="nothing-to-apply">
                {t("conflict.nothingToApply")}
              </p>
            ) : null}
            {plan!.notApplicable.length > 0 ? (
              <p className="text-sm text-zinc-600">{t("conflict.willSkip", { count: plan!.notApplicable.length })}</p>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row">
              {plan!.apply.length > 0 ? <Button onClick={reapply}>{t("conflict.reapply")}</Button> : null}
              <Button variant={plan!.apply.length > 0 ? "ghost" : "primary"} onClick={discard}>
                {plan!.apply.length > 0 ? t("conflict.discard") : t("conflict.ok")}
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function History({ derived, promotionId }: { derived: Derived; promotionId: string }) {
  const t = useTranslations("order");
  const locale = useLocale();
  const online = useOnline();
  const { order } = derived;
  // Refresh the snapshot (and its audit history) whenever we are online.
  useQuery({
    queryKey: ["order-detail", order.key, order.serverId, order.version],
    queryFn: () => fetchOrderDetail(db, order.key, promotionId, order.serverId!),
    enabled: online && order.serverId !== null && !derived.needsResolution,
    retry: false,
  });
  return (
    <Card>
      <h2 className="mb-2 font-semibold">{t("history")}</h2>
      {order.auditEvents === null ? (
        <p className="text-sm text-zinc-500">{t("historyOffline")}</p>
      ) : (
        <ol className="space-y-1 text-sm" data-testid="history">
          {order.auditEvents.map((e) => (
            <li key={e.id} className="flex justify-between gap-2">
              <span>
                {t(`events.${e.eventType as "PAYMENT_MARKED"}`)}
                {e.reason ? <span className="text-zinc-500"> — {e.reason}</span> : null}
              </span>
              <span className="text-zinc-500">{formatDateTime(e.createdAt, locale)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function OrderDetail({ userId, promotion }: PromotionScope) {
  const t = useTranslations();
  const locale = useLocale();
  const ref = useSearchParams().get("order");
  const derived = useOrder(ref ? scopedKey(userId, ref) : null) as Derived | null | undefined;
  const products = useLiveQuery(
    () => db.products.where("[userId+promotionId]").equals([userId, promotion.id]).toArray(),
    [userId, promotion.id],
  );

  const back = (
    <Link href={promotionHref("/orders", promotion.id)} className="text-sm text-indigo-600">
      ← {t("orders.title")}
    </Link>
  );
  if (derived === undefined) return <p>{t("common.loading")}</p>;
  if (derived === null) {
    return (
      <div className="space-y-4">
        {back}
        <Card>
          <p>{t("order.notFound")}</p>
        </Card>
      </div>
    );
  }

  const { order, state } = derived;
  const money = (cents: bigint) => formatMoney(cents, promotion.currency, locale);
  const productName = (id: string, name: string) => name || products?.find((p) => p.id === id)?.name || "—";
  const creationRejected = order.sync === "failed" || order.sync === "conflict";
  const queued = derived.actions.filter((a) => a.status === "pending").length + (order.sync === "pending" ? 1 : 0);

  return (
    <div className="space-y-4 pb-8">
      {back}
      <Card>
        <div className="flex items-start justify-between gap-2">
          <h1 className="text-xl font-semibold">{t("order.title", { name: order.customerName })}</h1>
          {stateSummary(state)}
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          {t("order.placedAt", { date: formatDateTime(order.createdAt, locale) })}
        </p>
        {queued > 0 ? (
          <p className="mt-2">
            <Badge>{t("order.queued", { count: queued })}</Badge>
          </p>
        ) : null}
        <h2 className="mt-4 mb-2 font-semibold">{t("order.items")}</h2>
        <ul className="divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          {order.lines.map((line) => (
            <li key={line.productId} className="flex justify-between gap-2 py-2">
              <span>
                {line.quantity} × {productName(line.productId, line.name)}
              </span>
              <span className="tabular-nums">{money(lineTotal(parseMoney(line.unitPrice), line.quantity))}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex justify-between font-semibold">
          <span>{order.total ? t("order.total") : t("order.estimate")}</span>
          <span className="tabular-nums" data-testid="order-detail-total">
            {money(orderTotalCents(derived))}
          </span>
        </div>
      </Card>

      {derived.needsResolution ? (
        <ConflictResolution derived={derived} promotionId={promotion.id} />
      ) : creationRejected ? (
        <Card>
          <Link href={promotionHref("/sync", promotion.id)} className="text-indigo-600">
            {t("orders.needsAttention")} → {t("promotion.outbox")}
          </Link>
        </Card>
      ) : promotion.roles.includes("seller") ? (
        <ActionButtons derived={derived} />
      ) : null}

      <History derived={derived} promotionId={promotion.id} />
    </div>
  );
}

export default function OrderPage() {
  return <WithPromotion>{(scope) => <OrderDetail {...scope} />}</WithPromotion>;
}
