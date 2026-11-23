"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

import { type AdminScope, WithAdmin } from "@/components/admin/admin-scope";
import { Badge, Button, Card, ErrorBanner, Field } from "@/components/ui";
import { validDateRange } from "@/lib/admin/forms";
import { api, type Schemas, unwrap } from "@/lib/api/client";
import { db } from "@/lib/db";
import { useErrorMessage } from "@/lib/hooks";
import { refreshPromotions } from "@/lib/offline/refresh";

const CURRENCIES = ["BRL", "USD", "EUR", "GBP", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK"] as const;
type Status = Schemas["PromotionStatus"];

/** Mirrors the backend status machine (docs/erm.md §2.2). */
const NEXT_STATUS: Record<Status, { to: Status; label: "ACTIVE" | "CLOSED" | "REOPEN" }[]> = {
  DRAFT: [{ to: "ACTIVE", label: "ACTIVE" }],
  ACTIVE: [{ to: "CLOSED", label: "CLOSED" }],
  CLOSED: [{ to: "ACTIVE", label: "REOPEN" }],
};

function SettingsForm({ promotion: p, userId }: { promotion: Schemas["PromotionResponse"]; userId: string }) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [name, setName] = useState(p.name);
  const [salesStart, setSalesStart] = useState(p.sales_start_date);
  const [lastSales, setLastSales] = useState(p.last_sales_date);
  const [delivery, setDelivery] = useState(p.delivery_date);
  const [currency, setCurrency] = useState<string>(p.currency);

  const update = useMutation({
    mutationFn: async (body: Schemas["PromotionUpdate"]) => {
      const updated = await unwrap(
        api.PATCH("/api/v1/promotions/{promotion_id}", { params: { path: { promotion_id: p.id } }, body }),
      );
      await refreshPromotions(db, userId); // status/dates gate the seller screens offline
      return updated;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["admin", p.id, "promotion"], updated);
      void queryClient.invalidateQueries({ queryKey: ["admin", p.id], refetchType: "none" });
    },
  });

  const datesOk = validDateRange(salesStart, lastSales, delivery);
  const save = (event: FormEvent) => {
    event.preventDefault();
    const changes: Schemas["PromotionUpdate"] = {};
    if (name.trim() !== p.name) changes.name = name.trim();
    if (salesStart !== p.sales_start_date) changes.sales_start_date = salesStart;
    if (lastSales !== p.last_sales_date) changes.last_sales_date = lastSales;
    if (delivery !== p.delivery_date) changes.delivery_date = delivery;
    if (currency !== p.currency) changes.currency = currency as Schemas["Currency"];
    update.mutate(changes);
  };
  const move = (to: Status) => {
    if (to === "CLOSED" && !window.confirm(t("settings.confirmClose"))) return;
    update.mutate({ status: to });
  };

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="mb-2 font-semibold">{t("settings.status")}</h2>
        <div className="flex flex-wrap items-center gap-3">
          <span data-testid="promotion-status">
            <Badge tone={p.status === "ACTIVE" ? "green" : p.status === "CLOSED" ? "amber" : "neutral"}>
              {t(`promotions.status.${p.status}`)}
            </Badge>
          </span>
          <span className="text-sm text-zinc-600 dark:text-zinc-400">{t(`settings.statusHint.${p.status}`)}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {NEXT_STATUS[p.status].map(({ to, label }) => (
            <Button key={label} variant={to === "CLOSED" ? "ghost" : "primary"} onClick={() => move(to)} disabled={update.isPending}>
              {t(`settings.to.${label}`)}
            </Button>
          ))}
        </div>
      </Card>

      <Card>
        <form onSubmit={save} className="space-y-4" aria-label={t("settings.title")}>
          <h2 className="font-semibold">{t("settings.title")}</h2>
          <Field label={t("newPromotion.name")} value={name} onChange={(e) => setName(e.target.value)} required />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("newPromotion.salesStart")} type="date" value={salesStart} onChange={(e) => setSalesStart(e.target.value)} required />
            <Field label={t("newPromotion.lastSales")} type="date" value={lastSales} onChange={(e) => setLastSales(e.target.value)} required />
            <Field label={t("newPromotion.delivery")} type="date" value={delivery} onChange={(e) => setDelivery(e.target.value)} required />
          </div>
          {!datesOk ? <ErrorBanner message={t("newPromotion.invalidDates")} /> : null}
          <label className="block space-y-1">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{t("newPromotion.currency")}</span>
            <select
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-3 dark:border-zinc-700 dark:bg-zinc-950"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="text-xs text-zinc-500">{t("newPromotion.currencyHint")}</span>
          </label>
          <ErrorBanner message={update.isError ? errorMessage(update.error) : null} />
          {update.isSuccess ? (
            <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
              ✓ {t("form.saved")}
            </p>
          ) : null}
          <Button type="submit" disabled={!datesOk || !name.trim() || update.isPending}>
            {t("form.save")}
          </Button>
        </form>
      </Card>
    </div>
  );
}

function Settings({ promotion, userId }: AdminScope) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const query = useQuery({
    queryKey: ["admin", promotion.id, "promotion"],
    queryFn: () =>
      unwrap(api.GET("/api/v1/promotions/{promotion_id}", { params: { path: { promotion_id: promotion.id } } })),
  });
  if (query.isError) return <ErrorBanner message={errorMessage(query.error)} />;
  if (!query.data) return <p>{t("common.loading")}</p>;
  // key: re-initialize the form fields whenever the server version changes.
  return <SettingsForm key={query.data.updated_at} promotion={query.data} userId={userId} />;
}

export default function SettingsPage() {
  return <WithAdmin adminOnly>{(scope) => <Settings {...scope} />}</WithAdmin>;
}
