"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

import { type AdminScope, WithAdmin } from "@/components/admin/admin-scope";
import { MoneyField } from "@/components/admin/money-field";
import { Badge, Button, Card, ErrorBanner, Field } from "@/components/ui";
import { moneyToInput, parseMoneyInput } from "@/lib/admin/forms";
import { api, type Schemas, unwrap } from "@/lib/api/client";
import { useLastError } from "@/lib/admin/last-error";
import { useErrorMessage } from "@/lib/hooks";
import { formatMoney, parseMoney } from "@/lib/money";

type Product = Schemas["ProductResponse"];

function ProductForm({
  currency,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  pending,
}: {
  currency: string;
  initial?: Product;
  submitLabel: string;
  onSubmit: (body: { name: string; description: string | null; price: string }) => void;
  onCancel?: () => void;
  pending: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [price, setPrice] = useState(initial ? moneyToInput(initial.price, locale) : "");
  const parsed = parseMoneyInput(price);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!parsed.ok || !name.trim()) return;
    onSubmit({ name: name.trim(), description: description.trim() || null, price: parsed.value });
  };
  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-3 md:grid-cols-3" aria-label={submitLabel}>
      <Field label={t("products.name")} value={name} onChange={(e) => setName(e.target.value)} required />
      <MoneyField value={price} onChange={setPrice} currency={currency} />
      <Field label={t("products.description")} value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="flex gap-2 md:col-span-3">
        <Button type="submit" disabled={!parsed.ok || !name.trim() || pending}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("form.cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function Products({ promotion }: AdminScope) {
  const t = useTranslations();
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const key = ["admin", promotion.id, "products"];
  const products = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/promotions/{promotion_id}/products", {
          params: { path: { promotion_id: promotion.id }, query: { include_inactive: true, page: 1, size: 100 } },
        }),
      ),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: key });
  const last = useLastError();

  const create = useMutation({
    mutationFn: (body: { name: string; description: string | null; price: string }) =>
      unwrap(
        api.POST("/api/v1/promotions/{promotion_id}/products", {
          params: { path: { promotion_id: promotion.id } },
          body,
        }),
      ),
    ...last.handlers,
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Schemas["ProductUpdate"] }) =>
      unwrap(
        api.PATCH("/api/v1/promotions/{promotion_id}/products/{product_id}", {
          params: { path: { promotion_id: promotion.id, product_id: id } },
          body,
        }),
      ),
    ...last.handlers,
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });

  const error = last.error ?? products.error;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t("products.title")}</h1>
      <Card>
        <h2 className="mb-3 font-semibold">{t("products.add")}</h2>
        {/* key changes only after a SUCCESSFUL creation: on error, the typed values stay. */}
        <ProductForm
          key={create.data?.id ?? "new"}
          currency={promotion.currency}
          submitLabel={t("products.add")}
          onSubmit={(body) => create.mutate(body)}
          pending={create.isPending}
        />
      </Card>
      <ErrorBanner message={error ? errorMessage(error) : null} />
      <Card>
        {!products.data ? (
          <p>{t("common.loading")}</p>
        ) : products.data.items.length === 0 ? (
          <p className="text-zinc-500">{t("products.empty")}</p>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800" data-testid="products">
            {products.data.items.map((p) => (
              <li key={p.id} className="py-3" data-testid="product-row">
                {editing === p.id ? (
                  <ProductForm
                    currency={promotion.currency}
                    initial={p}
                    submitLabel={t("form.save")}
                    onSubmit={(body) => update.mutate({ id: p.id, body })}
                    onCancel={() => setEditing(null)}
                    pending={update.isPending}
                  />
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className={`font-medium ${p.is_active ? "" : "text-zinc-400 line-through"}`}>{p.name}</span>{" "}
                      {!p.is_active ? <Badge>{t("products.archived")}</Badge> : null}
                      {p.description ? <p className="text-sm text-zinc-500">{p.description}</p> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums">{formatMoney(parseMoney(p.price), promotion.currency, locale)}</span>
                      <Button variant="ghost" onClick={() => setEditing(p.id)}>
                        {t("products.edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => update.mutate({ id: p.id, body: { is_active: !p.is_active } })}
                      >
                        {p.is_active ? t("products.archive") : t("products.restore")}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function ProductsPage() {
  return <WithAdmin adminOnly>{(scope) => <Products {...scope} />}</WithAdmin>;
}
