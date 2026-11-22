"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { promotionHref } from "@/components/promotion-scope";
import { RequireAuth } from "@/components/require-auth";
import { Badge, Card } from "@/components/ui";
import type { CachedPromotion } from "@/lib/db";
import { usePromotions, useUserId } from "@/lib/offline/hooks";

const STATUS_TONE = { DRAFT: "neutral", ACTIVE: "green", CLOSED: "amber" } as const;

function PromotionRow({ promotion }: { promotion: CachedPromotion }) {
  const t = useTranslations("promotions");
  return (
    <li>
      <Link
        href={promotionHref("", promotion.id)}
        className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 p-4 hover:border-indigo-400 dark:border-zinc-800"
      >
        <span className="font-medium">{promotion.name}</span>
        <span className="flex flex-wrap justify-end gap-1">
          <Badge tone={STATUS_TONE[promotion.status]}>{t(`status.${promotion.status}`)}</Badge>
          {promotion.roles.map((role) => (
            <Badge key={role}>{t(`roles.${role as "seller"}`)}</Badge>
          ))}
        </span>
      </Link>
    </li>
  );
}

function PromotionList() {
  const t = useTranslations();
  const promotions = usePromotions(useUserId());

  if (promotions === undefined) return <p>{t("common.loading")}</p>;
  return (
    <Card>
      <h1 className="mb-4 text-xl font-semibold">{t("promotions.title")}</h1>
      {promotions.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">{t("promotions.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {promotions.map((p) => (
            <PromotionRow key={p.key} promotion={p} />
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function PromotionsPage() {
  return (
    <RequireAuth>
      <PromotionList />
    </RequireAuth>
  );
}
