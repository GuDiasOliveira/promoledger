"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

import { type AdminScope, adminOrderHref, WithAdmin } from "@/components/admin/admin-scope";
import { ClassificationBadge } from "@/components/order-ui";
import { Card, ErrorBanner } from "@/components/ui";
import { formatPercent, shareBasisPoints } from "@/lib/admin/format";
import { useDivergences, useLeaderboard, useSummary } from "@/lib/admin/queries";
import { formatDateTime } from "@/lib/format";
import { useErrorMessage } from "@/lib/hooks";
import { formatMoney, parseMoney } from "@/lib/money";
import type { Classification } from "@/lib/orders/state";

const ORDER: Classification[] = [
  "SETTLED",
  "PAID_PENDING",
  "UNPAID_PENDING",
  "DIVERGENCE",
  "CANCELLED",
];
const BAR_COLOR: Record<Classification, string> = {
  SETTLED: "bg-emerald-500",
  PAID_PENDING: "bg-amber-400",
  UNPAID_PENDING: "bg-zinc-400",
  DIVERGENCE: "bg-red-500",
  CANCELLED: "bg-zinc-200 dark:bg-zinc-700",
};

function Kpi({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <Card>
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid={testId}>
        {value}
      </p>
    </Card>
  );
}

function Dashboard({ promotion }: AdminScope) {
  const t = useTranslations();
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const summary = useSummary(promotion.id);
  const leaderboard = useLeaderboard(promotion.id);
  const divergences = useDivergences(promotion.id);
  const money = (amount: string) => formatMoney(parseMoney(amount), promotion.currency, locale);

  if (summary.isError) return <ErrorBanner message={errorMessage(summary.error)} />;
  if (!summary.data) return <p>{t("common.loading")}</p>;
  const s = summary.data;
  // Cancelled orders are excluded from revenue: the bar shows the live orders' split.
  const liveTotal = s.total_revenue;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label={t("admin.kpi.revenue")} value={money(s.total_revenue)} testId="kpi-revenue" />
        <Kpi
          label={t("admin.kpi.collected")}
          value={money(s.collected_amount)}
          testId="kpi-collected"
        />
        <Kpi
          label={t("admin.kpi.outstanding")}
          value={money(s.outstanding_amount)}
          testId="kpi-outstanding"
        />
        <Kpi
          label={t("admin.kpi.units")}
          value={t("admin.kpi.unitsValue", {
            delivered: s.units_delivered,
            ordered: s.units_ordered,
          })}
          testId="kpi-units"
        />
      </div>

      <Card>
        <h2 className="mb-3 font-semibold">{t("admin.breakdown")}</h2>
        <div
          className="flex h-3 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
          aria-hidden
        >
          {ORDER.filter((c) => c !== "CANCELLED").map((c) => (
            <div
              key={c}
              className={BAR_COLOR[c]}
              style={{
                width: `${shareBasisPoints(s.by_classification[c].amount, liveTotal) / 100}%`,
              }}
            />
          ))}
        </div>
        <ul className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2 lg:grid-cols-5">
          {ORDER.map((c) => (
            <li key={c} className="flex flex-col gap-1" data-testid={`bucket-${c}`}>
              <ClassificationBadge value={c} />
              <span className="tabular-nums">{money(s.by_classification[c].amount)}</span>
              <span className="text-zinc-500">
                {t("admin.count", { count: s.by_classification[c].count })}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">{t("admin.divergences")}</h2>
        {!divergences.data ? (
          <p>{t("common.loading")}</p>
        ) : divergences.data.items.length === 0 ? (
          <p className="text-emerald-700 dark:text-emerald-400">✓ {t("admin.noDivergences")}</p>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800" data-testid="divergences">
            {divergences.data.items.map((o) => (
              <li key={o.id}>
                <Link
                  href={adminOrderHref(promotion.id, o.id)}
                  className="flex items-center justify-between gap-2 py-2 hover:text-indigo-600"
                >
                  <span className="font-medium">{o.customer.name}</span>
                  <span className="text-sm text-zinc-500">
                    {formatDateTime(o.created_at, locale)}
                  </span>
                  <span className="tabular-nums">{money(o.total_amount)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">{t("admin.leaderboard")}</h2>
        {!leaderboard.data ? (
          <p>{t("common.loading")}</p>
        ) : leaderboard.data.length === 0 ? (
          <p className="text-zinc-500">{t("admin.noSales")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm" data-testid="leaderboard">
              <thead className="text-left text-zinc-500">
                <tr>
                  <th className="py-2">#</th>
                  <th>{t("admin.col.seller")}</th>
                  <th className="text-right">{t("admin.col.orders")}</th>
                  <th className="text-right">{t("admin.col.units")}</th>
                  <th className="text-right">{t("admin.col.gross")}</th>
                  <th className="text-right">{t("admin.col.settled")}</th>
                  <th className="text-right">{t("admin.col.settledPct")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 tabular-nums dark:divide-zinc-800">
                {leaderboard.data.map((row, index) => (
                  <tr key={row.member_id}>
                    <td className="py-2">{index + 1}</td>
                    <td className="font-medium">{row.name}</td>
                    <td className="text-right">{row.order_count}</td>
                    <td className="text-right">{row.units_sold}</td>
                    <td className="text-right">{money(row.gross_revenue)}</td>
                    <td className="text-right">{money(row.settled_amount)}</td>
                    <td className="text-right">
                      {formatPercent(row.settlement_percentage, locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function AdminDashboardPage() {
  return <WithAdmin>{(scope) => <Dashboard {...scope} />}</WithAdmin>;
}
