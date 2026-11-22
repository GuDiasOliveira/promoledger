"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { RequireAuth } from "@/components/require-auth";
import { Badge, Card, ErrorBanner } from "@/components/ui";
import type { Schemas } from "@/lib/api/client";
import { useErrorMessage, useMe } from "@/lib/hooks";

type Membership = Schemas["PromotionMembershipSummary"];

const STATUS_TONE = { DRAFT: "neutral", ACTIVE: "green", CLOSED: "amber" } as const;

function MembershipRow({ membership }: { membership: Membership }) {
  const t = useTranslations("promotions");
  return (
    <li>
      <Link
        href={`/p/${membership.promotion_id}`}
        className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 p-4 hover:border-indigo-400 dark:border-zinc-800"
      >
        <span className="font-medium">{membership.promotion_name}</span>
        <span className="flex flex-wrap justify-end gap-1">
          <Badge tone={STATUS_TONE[membership.promotion_status]}>
            {t(`status.${membership.promotion_status}`)}
          </Badge>
          {membership.roles.map((role) => (
            <Badge key={role}>{t(`roles.${role}`)}</Badge>
          ))}
        </span>
      </Link>
    </li>
  );
}

function PromotionList() {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const me = useMe();

  if (me.isPending) return <p>{t("common.loading")}</p>;
  if (me.isError) return <ErrorBanner message={errorMessage(me.error)} />;

  return (
    <Card>
      <h1 className="mb-4 text-xl font-semibold">{t("promotions.title")}</h1>
      {me.data.memberships.length === 0 ? (
        <p className="text-zinc-600 dark:text-zinc-400">{t("promotions.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {me.data.memberships.map((m) => (
            <MembershipRow key={m.member_id} membership={m} />
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
