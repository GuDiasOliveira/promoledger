"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, Suspense, useEffect } from "react";

import { RequireAuth } from "@/components/require-auth";
import type { CachedPromotion } from "@/lib/db";
import { usePromotion, useUserId } from "@/lib/offline/hooks";

import { Card } from "./ui";

export interface PromotionScope {
  userId: string;
  promotion: CachedPromotion;
}

function Resolve({ children }: { children: (scope: PromotionScope) => ReactNode }) {
  const t = useTranslations();
  const router = useRouter();
  const promotionId = useSearchParams().get("id");
  const userId = useUserId();
  const promotion = usePromotion(userId, promotionId);

  useEffect(() => {
    if (!promotionId) router.replace("/promotions");
  }, [promotionId, router]);

  if (!promotionId || !userId || promotion === undefined) return <p>{t("common.loading")}</p>;
  if (promotion === null) {
    return (
      <Card>
        <p>{t("promotion.notFound")}</p>
        <Link href="/promotions" className="mt-3 inline-block text-indigo-600">
          ← {t("common.back")}
        </Link>
      </Card>
    );
  }
  return <>{children({ userId, promotion })}</>;
}

/**
 * Promotion-scoped pages are static routes with `?id=` (one cacheable HTML for every
 * promotion, so they open offline). `useSearchParams` requires a Suspense boundary.
 */
export function WithPromotion({ children }: { children: (scope: PromotionScope) => ReactNode }) {
  return (
    <RequireAuth>
      <Suspense>
        <Resolve>{children}</Resolve>
      </Suspense>
    </RequireAuth>
  );
}

export const promotionHref = (path: "" | "/sell" | "/sync", id: string) => `/promotion${path}?id=${id}`;
