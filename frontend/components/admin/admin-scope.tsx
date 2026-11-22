"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { type PromotionScope, promotionHref, WithPromotion } from "@/components/promotion-scope";
import { Card } from "@/components/ui";
import { useOnline } from "@/lib/offline/hooks";

export interface AdminScope extends PromotionScope {
  isAdmin: boolean; // false = promotion_viewer (read-only)
}

const NAV = [
  { href: "/promotion/admin", key: "dashboard", adminOnly: false },
  { href: "/promotion/admin/orders", key: "orders", adminOnly: false },
  { href: "/promotion/admin/audit", key: "audit", adminOnly: true }, // API: admin only
] as const;

function AdminNav({ scope }: { scope: AdminScope }) {
  const t = useTranslations("admin.nav");
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-zinc-200 pb-2 dark:border-zinc-800">
      {NAV.filter((item) => scope.isAdmin || !item.adminOnly).map((item) => {
        const active = pathname === item.href || (item.key === "orders" && pathname === "/promotion/admin/order");
        return (
          <Link
            key={item.key}
            href={`${item.href}?id=${scope.promotion.id}`}
            aria-current={active ? "page" : undefined}
            className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium ${
              active ? "bg-indigo-600 text-white" : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            {t(item.key)}
          </Link>
        );
      })}
    </nav>
  );
}

function Gate({
  scope,
  adminOnly,
  children,
}: {
  scope: PromotionScope;
  adminOnly: boolean;
  children: (scope: AdminScope) => ReactNode;
}) {
  const t = useTranslations();
  const online = useOnline();
  const isAdmin = scope.promotion.roles.includes("promotion_admin");
  const isViewer = scope.promotion.roles.includes("promotion_viewer");
  const allowed = adminOnly ? isAdmin : isAdmin || isViewer;
  const adminScope: AdminScope = { ...scope, isAdmin };

  return (
    <div className="space-y-4">
      <Link href={promotionHref("", scope.promotion.id)} className="text-sm text-indigo-600">
        ← {scope.promotion.name}
      </Link>
      {!allowed ? (
        <Card>
          <p role="alert">{t("errors.codes.INSUFFICIENT_ROLE")}</p>
        </Card>
      ) : !online ? (
        <Card>
          <p role="alert">{t("admin.onlineOnly")}</p>
        </Card>
      ) : (
        <>
          <AdminNav scope={adminScope} />
          {children(adminScope)}
        </>
      )}
    </div>
  );
}

/** Admin/viewer pages: role-gated (mirrors the API), online-only, with shared navigation. */
export function WithAdmin({
  adminOnly = false,
  children,
}: {
  adminOnly?: boolean;
  children: (scope: AdminScope) => ReactNode;
}) {
  return (
    <WithPromotion>
      {(scope) => (
        <Gate scope={scope} adminOnly={adminOnly}>
          {children}
        </Gate>
      )}
    </WithPromotion>
  );
}

export const adminOrderHref = (promotionId: string, orderId: string) =>
  `/promotion/admin/order?id=${promotionId}&order=${orderId}`;
