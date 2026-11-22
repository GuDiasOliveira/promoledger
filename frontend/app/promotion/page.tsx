"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

import { type PromotionScope, promotionHref, WithPromotion } from "@/components/promotion-scope";
import { Badge, Card } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { useOutbox, usePromotionData } from "@/lib/offline/hooks";

function PromotionHome({ userId, promotion: p }: PromotionScope) {
  const t = useTranslations();
  const locale = useLocale();
  // Download catalog + customers now, so the order screen works if the signal drops later.
  usePromotionData(userId, p.id);
  const pending = useOutbox(userId, p.id)?.length ?? 0;
  const canSell = p.roles.includes("seller");

  return (
    <div className="space-y-4">
      <Link href="/promotions" className="text-sm text-indigo-600">
        ← {t("common.back")}
      </Link>
      <Card>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h1 className="text-xl font-semibold">{p.name}</h1>
          <Badge>{t(`promotions.status.${p.status}`)}</Badge>
        </div>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-zinc-500">{t("promotion.salesWindow")}</dt>
            <dd>
              {t("promotion.range", {
                start: formatDate(p.salesStartDate, locale),
                end: formatDate(p.lastSalesDate, locale),
              })}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">{t("promotion.deliveryDate")}</dt>
            <dd>{formatDate(p.deliveryDate, locale)}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">{t("promotion.currency")}</dt>
            <dd>{p.currency}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">{t("promotion.yourRoles")}</dt>
            <dd className="flex flex-wrap gap-1">
              {p.roles.map((role) => (
                <Badge key={role}>{t(`promotions.roles.${role as "seller"}`)}</Badge>
              ))}
            </dd>
          </div>
        </dl>
      </Card>

      {canSell ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {p.status === "ACTIVE" ? (
            <Link
              href={promotionHref("/sell", p.id)}
              className="flex min-h-14 items-center justify-center rounded-xl bg-indigo-600 px-4 text-lg font-semibold text-white"
            >
              {t("promotion.newOrder")}
            </Link>
          ) : (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{t("promotion.notActive")}</p>
          )}
          <Link
            href={promotionHref("/sync", p.id)}
            className="flex min-h-14 items-center justify-center gap-2 rounded-xl border border-zinc-300 px-4 font-medium dark:border-zinc-700"
          >
            {t("promotion.outbox")}
            {pending > 0 ? <Badge tone="amber">{t("common.pending", { count: pending })}</Badge> : null}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export default function PromotionPage() {
  return <WithPromotion>{(scope) => <PromotionHome {...scope} />}</WithPromotion>;
}
