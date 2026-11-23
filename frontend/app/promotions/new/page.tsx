"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

import { RequireAuth } from "@/components/require-auth";
import { Button, Card, ErrorBanner, Field } from "@/components/ui";
import { validDateRange } from "@/lib/admin/forms";
import { api, unwrap } from "@/lib/api/client";
import { db } from "@/lib/db";
import { useErrorMessage } from "@/lib/hooks";
import { useOnline, useUserId } from "@/lib/offline/hooks";
import { refreshPromotions } from "@/lib/offline/refresh";

// MVP allowlist (docs/erm.md §2.2): 2-decimal ISO 4217 currencies.
const CURRENCIES = ["BRL", "USD", "EUR", "GBP", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK"] as const;
type Currency = (typeof CURRENCIES)[number];

function InstitutionPicker({
  value,
  onChange,
}: {
  value: { id: string | null; name: string } | null;
  onChange: (v: { id: string | null; name: string } | null) => void;
}) {
  const t = useTranslations("newPromotion");
  const [q, setQ] = useState("");
  const results = useQuery({
    queryKey: ["institutions", q],
    queryFn: () =>
      unwrap(api.GET("/api/v1/institutions", { params: { query: { q, page: 1, size: 8 } } })),
    enabled: q.trim().length >= 2,
  });

  if (value) {
    return (
      <div className="flex items-end justify-between gap-2">
        <div>
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {t("institution")}
          </span>
          <p className="py-2 font-medium" data-testid="institution-choice">
            {value.name}
          </p>
        </div>
        <Button type="button" variant="ghost" onClick={() => onChange(null)}>
          {t("change")}
        </Button>
      </div>
    );
  }
  const exact = results.data?.items.some((i) => i.name.toLowerCase() === q.trim().toLowerCase());
  return (
    <div className="space-y-2">
      <Field
        label={t("searchInstitution")}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul className="space-y-1">
        {(results.data?.items ?? []).map((i) => (
          <li key={i.id}>
            <button
              type="button"
              className="min-h-11 w-full rounded-lg border border-zinc-200 px-3 text-left hover:border-indigo-400 dark:border-zinc-800"
              onClick={() => onChange({ id: i.id, name: i.name })}
            >
              {i.name}
            </button>
          </li>
        ))}
      </ul>
      {q.trim().length >= 2 && results.data && !exact ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => onChange({ id: null, name: q.trim() })}
        >
          + {t("createInstitution", { name: q.trim() })}
        </Button>
      ) : null}
    </div>
  );
}

function NewPromotion() {
  const t = useTranslations();
  const router = useRouter();
  const online = useOnline();
  const userId = useUserId();
  const errorMessage = useErrorMessage();
  const [name, setName] = useState("");
  const [institution, setInstitution] = useState<{ id: string | null; name: string } | null>(null);
  const [salesStart, setSalesStart] = useState("");
  const [lastSales, setLastSales] = useState("");
  const [delivery, setDelivery] = useState("");
  const [currency, setCurrency] = useState<Currency | "">("");

  const datesOk = validDateRange(salesStart, lastSales, delivery);
  const datesTouched = Boolean(salesStart && lastSales && delivery);
  const ready = name.trim() && institution && datesOk && currency;

  const create = useMutation({
    mutationFn: async () => {
      const institutionId =
        institution!.id ??
        (await unwrap(api.POST("/api/v1/institutions", { body: { name: institution!.name } }))).id;
      const promotion = await unwrap(
        api.POST("/api/v1/promotions", {
          body: {
            name: name.trim(),
            institution_id: institutionId,
            sales_start_date: salesStart,
            last_sales_date: lastSales,
            delivery_date: delivery,
            currency: currency as Currency,
          },
        }),
      );
      await refreshPromotions(db, userId!); // the new promotion appears everywhere right away
      return promotion;
    },
    onSuccess: (promotion) => router.push(`/promotion/admin/products?id=${promotion.id}`),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) create.mutate();
  };

  if (!online) {
    return (
      <Card>
        <p role="alert">{t("admin.onlineOnly")}</p>
      </Card>
    );
  }
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <Link href="/promotions" className="text-sm text-indigo-600">
        ← {t("promotions.title")}
      </Link>
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <h1 className="text-xl font-semibold">{t("newPromotion.title")}</h1>
          <Field
            label={t("newPromotion.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <InstitutionPicker value={institution} onChange={setInstitution} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field
              label={t("newPromotion.salesStart")}
              type="date"
              value={salesStart}
              onChange={(e) => setSalesStart(e.target.value)}
              required
            />
            <Field
              label={t("newPromotion.lastSales")}
              type="date"
              value={lastSales}
              onChange={(e) => setLastSales(e.target.value)}
              required
            />
            <Field
              label={t("newPromotion.delivery")}
              type="date"
              value={delivery}
              onChange={(e) => setDelivery(e.target.value)}
              required
            />
          </div>
          {datesTouched && !datesOk ? (
            <ErrorBanner message={t("newPromotion.invalidDates")} />
          ) : null}
          <label className="block space-y-1">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {t("newPromotion.currency")}
            </span>
            <select
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-3 dark:border-zinc-700 dark:bg-zinc-950"
              value={currency}
              onChange={(e) => setCurrency(e.target.value as Currency)}
              required
            >
              <option value="" disabled>
                —
              </option>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="text-xs text-zinc-500">{t("newPromotion.currencyHint")}</span>
          </label>
          <ErrorBanner message={create.isError ? errorMessage(create.error) : null} />
          <Button type="submit" className="w-full" disabled={!ready || create.isPending}>
            {t("newPromotion.create")}
          </Button>
        </form>
      </Card>
    </div>
  );
}

export default function NewPromotionPage() {
  return (
    <RequireAuth>
      <NewPromotion />
    </RequireAuth>
  );
}
