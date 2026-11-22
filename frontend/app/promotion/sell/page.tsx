"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useMemo, useState } from "react";

import { type PromotionScope, promotionHref, WithPromotion } from "@/components/promotion-scope";
import { Badge, Button, Card, Field } from "@/components/ui";
import { type CachedCustomer, db } from "@/lib/db";
import { formatMoney, lineTotal, parseMoney, sumMoney } from "@/lib/money";
import { usePromotionData } from "@/lib/offline/hooks";
import { createCustomerOffline, createOrderOffline } from "@/lib/sync/outbox";
import { requestSync } from "@/lib/sync/runner";

const MAX_QUANTITY = 1000;

/** Case- and accent-insensitive matching ("joao" finds "João"). */
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

function CustomerPicker({
  scope,
  customers,
  onPick,
}: {
  scope: PromotionScope;
  customers: CachedCustomer[];
  onPick: (c: CachedCustomer) => void;
}) {
  const t = useTranslations("sell");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");

  const matches = useMemo(() => {
    const q = fold(query.trim());
    return customers
      .filter((c) => !q || fold(c.name).includes(q) || fold(c.contact ?? "").includes(q))
      .slice(0, 8);
  }, [customers, query]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const customer = await createCustomerOffline(db, {
      userId: scope.userId,
      promotionId: scope.promotion.id,
      name: name.trim(),
      contact: contact.trim() || null,
    });
    requestSync();
    onPick(customer);
  };

  if (creating) {
    return (
      <form onSubmit={create} className="space-y-3">
        <Field label={t("customerName")} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <Field label={t("customerContact")} value={contact} onChange={(e) => setContact(e.target.value)} />
        <div className="flex gap-2">
          <Button type="submit" disabled={!name.trim()}>
            {t("addCustomer")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
            ←
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-3">
      <Field label={t("searchCustomer")} value={query} onChange={(e) => setQuery(e.target.value)} type="search" />
      {matches.length === 0 ? <p className="text-sm text-zinc-500">{t("noCustomers")}</p> : null}
      <ul className="space-y-1">
        {matches.map((c) => (
          <li key={c.key}>
            <button
              type="button"
              onClick={() => onPick(c)}
              className="flex min-h-11 w-full items-center justify-between rounded-lg border border-zinc-200 px-3 py-2 text-left hover:border-indigo-400 dark:border-zinc-800"
            >
              <span>{c.name}</span>
              <span className="text-sm text-zinc-500">{c.contact}</span>
            </button>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          setName(query.trim());
          setCreating(true);
        }}
      >
        + {t("newCustomer")}
      </Button>
    </div>
  );
}

function SellForm(scope: PromotionScope) {
  const t = useTranslations();
  const locale = useLocale();
  const { promotion } = scope;
  const { products, customers } = usePromotionData(scope.userId, promotion.id);
  const [customer, setCustomer] = useState<CachedCustomer | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [markPaidNow, setMarkPaidNow] = useState(false);
  const [saved, setSaved] = useState(false);

  const money = (cents: bigint) => formatMoney(cents, promotion.currency, locale);
  const lines = (products ?? [])
    .filter((p) => (quantities[p.id] ?? 0) > 0)
    .map((p) => ({ productId: p.id, name: p.name, quantity: quantities[p.id], unitPrice: p.price }));
  const total = sumMoney(lines.map((l) => lineTotal(parseMoney(l.unitPrice), l.quantity)));

  const change = (productId: string, delta: number) =>
    setQuantities((q) => ({
      ...q,
      [productId]: Math.min(MAX_QUANTITY, Math.max(0, (q[productId] ?? 0) + delta)),
    }));

  const save = async () => {
    if (!customer || lines.length === 0) return;
    await createOrderOffline(db, {
      userId: scope.userId,
      promotionId: promotion.id,
      customerId: customer.id,
      customerName: customer.name,
      lines,
      markPaidNow,
    });
    requestSync();
    setSaved(true);
  };

  const reset = () => {
    setCustomer(null);
    setQuantities({});
    setMarkPaidNow(false);
    setSaved(false);
  };

  if (saved) {
    return (
      <Card>
        <p role="status" className="mb-4 text-lg font-medium text-emerald-700 dark:text-emerald-400">
          ✓ {t("sell.saved")}
        </p>
        <div className="flex flex-col gap-2">
          <Button onClick={reset}>{t("sell.another")}</Button>
          <Link href={promotionHref("/sync", promotion.id)} className="text-center text-indigo-600">
            {t("sell.viewQueue")}
          </Link>
        </div>
      </Card>
    );
  }

  return (
    // Bottom padding = height of the fixed summary bar, so the last product stays reachable.
    <div className="space-y-4 pb-72">
      <Link href={promotionHref("", promotion.id)} className="text-sm text-indigo-600">
        ← {promotion.name}
      </Link>
      <h1 className="text-xl font-semibold">{t("sell.title")}</h1>

      <Card>
        <h2 className="mb-3 font-semibold">{t("sell.customer")}</h2>
        {customer ? (
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">
              {customer.name} {customer.sync !== "synced" ? <Badge tone="amber">{t("sync.status.pending")}</Badge> : null}
            </span>
            <Button variant="ghost" onClick={() => setCustomer(null)}>
              {t("sell.changeCustomer")}
            </Button>
          </div>
        ) : (
          <CustomerPicker scope={scope} customers={customers ?? []} onPick={setCustomer} />
        )}
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">{t("sell.products")}</h2>
        {products && products.length === 0 ? <p className="text-sm text-zinc-500">{t("sell.noProducts")}</p> : null}
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {(products ?? []).map((p) => {
            const qty = quantities[p.id] ?? 0;
            return (
              <li key={p.key} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-sm text-zinc-500">{money(parseMoney(p.price))}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={t("sell.decrease", { name: p.name })}
                    onClick={() => change(p.id, -1)}
                    disabled={qty === 0}
                    className="h-11 w-11 rounded-full border border-zinc-300 text-xl disabled:opacity-30 dark:border-zinc-700"
                  >
                    −
                  </button>
                  <output aria-live="polite" className="w-8 text-center text-lg tabular-nums">
                    {qty}
                  </output>
                  <button
                    type="button"
                    aria-label={t("sell.increase", { name: p.name })}
                    onClick={() => change(p.id, 1)}
                    className="h-11 w-11 rounded-full bg-indigo-600 text-xl text-white"
                  >
                    +
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {/* Sticky summary: reachable with one thumb. */}
      <div className="fixed inset-x-0 bottom-0 border-t border-zinc-200 bg-white/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <span className="font-medium">{t("sell.total")}</span>
            <span className="text-xl font-semibold tabular-nums" data-testid="order-total">
              {money(total)}
            </span>
          </div>
          <p className="text-xs text-zinc-500">{t("sell.totalHint")}</p>
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              checked={markPaidNow}
              onChange={(e) => setMarkPaidNow(e.target.checked)}
              className="h-5 w-5"
            />
            {t("sell.markPaidNow")}
          </label>
          <Button onClick={save} disabled={!customer || lines.length === 0} className="w-full text-lg">
            {t("sell.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function SellPage() {
  return (
    <WithPromotion>
      {(scope) =>
        scope.promotion.status === "ACTIVE" && scope.promotion.roles.includes("seller") ? (
          <SellForm {...scope} />
        ) : (
          <SellUnavailable />
        )
      }
    </WithPromotion>
  );
}

function SellUnavailable() {
  const t = useTranslations("promotion");
  return (
    <Card>
      <p>{t("notActive")}</p>
    </Card>
  );
}
