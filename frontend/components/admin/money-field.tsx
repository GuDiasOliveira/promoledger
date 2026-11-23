"use client";

import { useLocale, useTranslations } from "next-intl";

import { Field } from "@/components/ui";
import { parseMoneyInput } from "@/lib/admin/forms";
import { formatMoney, parseMoney } from "@/lib/money";

/** Price input: accepts "19,90" or "19.90" and previews the exact value in the viewer's locale. */
export function MoneyField({
  value,
  onChange,
  currency,
}: {
  value: string;
  onChange: (raw: string) => void;
  currency: string;
}) {
  const t = useTranslations("products");
  const locale = useLocale();
  const parsed = value.trim() ? parseMoneyInput(value) : null;
  return (
    <div className="space-y-1">
      <Field
        label={t("price")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        autoComplete="off"
        hint={t("priceHint")}
        aria-invalid={parsed?.ok === false}
      />
      {parsed?.ok ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="price-preview">
          {t("preview", { value: formatMoney(parseMoney(parsed.value), currency, locale) })}
        </p>
      ) : parsed ? (
        <p className="text-sm text-red-700 dark:text-red-400" role="alert">
          {t(`priceErrors.${parsed.reason}`)}
        </p>
      ) : null}
    </div>
  );
}
