"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

import { RequireAuth } from "@/components/require-auth";
import { Badge, Card, ErrorBanner } from "@/components/ui";
import { api, unwrap } from "@/lib/api/client";
import { formatDate } from "@/lib/format";
import { useErrorMessage, useMe } from "@/lib/hooks";

function PromotionHome({ promotionId }: { promotionId: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const me = useMe();
  const promotion = useQuery({
    queryKey: ["promotion", promotionId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/promotions/{promotion_id}", {
          params: { path: { promotion_id: promotionId } },
        }),
      ),
  });

  if (promotion.isPending) return <p>{t("common.loading")}</p>;
  if (promotion.isError) return <ErrorBanner message={errorMessage(promotion.error)} />;

  const p = promotion.data;
  const roles = me.data?.memberships.find((m) => m.promotion_id === p.id)?.roles ?? [];
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
                start: formatDate(p.sales_start_date, locale),
                end: formatDate(p.last_sales_date, locale),
              })}
            </dd>
          </div>
          <div>
            <dt className="text-zinc-500">{t("promotion.deliveryDate")}</dt>
            <dd>{formatDate(p.delivery_date, locale)}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">{t("promotion.currency")}</dt>
            <dd>{p.currency}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">{t("promotion.yourRoles")}</dt>
            <dd className="flex flex-wrap gap-1">
              {roles.map((role) => (
                <Badge key={role}>{t(`promotions.roles.${role}`)}</Badge>
              ))}
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}

export default function PromotionPage() {
  const { promotionId } = useParams<{ promotionId: string }>();
  return (
    <RequireAuth>
      <PromotionHome promotionId={promotionId} />
    </RequireAuth>
  );
}
