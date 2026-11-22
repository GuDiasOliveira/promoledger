"use client";

import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { orderHref, type PromotionScope, promotionHref, WithPromotion } from "@/components/promotion-scope";
import { Badge, Button, Card } from "@/components/ui";
import { ApiError } from "@/lib/api/errors";
import { db, type OutboxItem } from "@/lib/db";
import { useErrorMessage } from "@/lib/hooks";
import { useOutbox } from "@/lib/offline/hooks";
import { transitionKind } from "@/lib/orders/state";
import { blockedItems, retryItem } from "@/lib/sync/engine";
import { discardOutboxItem } from "@/lib/sync/outbox";
import { requestSync } from "@/lib/sync/runner";

const STATUS_TONE = { pending: "neutral", failed: "amber", conflict: "amber" } as const;

function useLabel(item: OutboxItem): string {
  const t = useTranslations();
  const name = useLiveQuery(async () => {
    if (item.kind === "createCustomer") return (await db.customers.get(item.localRef))?.name;
    return (await db.orders.get(item.localRef))?.customerName;
  }, [item.localRef, item.kind]);
  if (item.kind === "transition") {
    return t("sync.kind.transition", {
      action: t(`order.actions.${transitionKind(item)}`),
      name: name ?? "…",
    });
  }
  return t(`sync.kind.${item.kind}`, { name: name ?? "…" });
}

function OutboxRow({ item, held }: { item: OutboxItem; held: boolean }) {
  const t = useTranslations("sync");
  const errorMessage = useErrorMessage();
  const label = useLabel(item);

  const retry = async () => {
    await retryItem(db, item.seq!);
    requestSync();
  };
  const discard = async () => {
    if (window.confirm(t("confirmDiscard"))) await discardOutboxItem(db, item);
  };

  return (
    <li className="space-y-2 py-3" data-testid="outbox-item">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{label}</span>
        <Badge tone={STATUS_TONE[item.status]}>{t(`status.${item.status}`)}</Badge>
      </div>
      {item.lastError ? (
        <p className="text-sm text-red-700 dark:text-red-400">{errorMessage(new ApiError(item.lastError))}</p>
      ) : null}
      {held ? <p className="text-sm text-zinc-600 dark:text-zinc-400">{t("held")}</p> : null}
      {item.attempts > 0 ? <p className="text-xs text-zinc-500">{t("attempts", { count: item.attempts })}</p> : null}
      <div className="flex gap-2">
        {item.kind === "transition" && item.status !== "pending" ? (
          // A rejected action is stale (version/state changed): resolve it on the order screen.
          <Link
            href={orderHref(item.promotionId, item.localRef.slice(item.userId.length + 1))}
            className="flex min-h-11 items-center rounded-lg px-4 font-medium text-indigo-600"
          >
            {t("resolve")}
          </Link>
        ) : (
          <Button variant="ghost" onClick={retry}>
            {t("retryNow")}
          </Button>
        )}
        {item.status !== "pending" ? (
          <Button variant="ghost" onClick={discard}>
            {t("discard")}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function SyncQueue({ userId, promotion }: PromotionScope) {
  const t = useTranslations();
  const items = useOutbox(userId, promotion.id);
  const held = blockedItems(items ?? []);

  return (
    <div className="space-y-4">
      <Link href={promotionHref("", promotion.id)} className="text-sm text-indigo-600">
        ← {promotion.name}
      </Link>
      <Card>
        <h1 className="mb-2 text-xl font-semibold">{t("sync.title")}</h1>
        {items === undefined ? (
          <p>{t("common.loading")}</p>
        ) : items.length === 0 ? (
          <p className="text-emerald-700 dark:text-emerald-400">✓ {t("sync.empty")}</p>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {items.map((item) => (
              <OutboxRow key={item.id} item={item} held={held.has(item.seq!)} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function SyncPage() {
  return <WithPromotion>{(scope) => <SyncQueue {...scope} />}</WithPromotion>;
}
