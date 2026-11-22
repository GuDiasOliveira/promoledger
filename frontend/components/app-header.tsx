"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

import { clearToken } from "@/lib/auth/session";
import { isLocale, localeLabels, locales } from "@/lib/i18n/config";
import { setLocale } from "@/lib/i18n/store";
import { useToken } from "@/lib/hooks";

import { Button } from "./ui";

export function LanguageSwitcher() {
  const t = useTranslations("common");
  const locale = useLocale();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">{t("language")}</span>
      <select
        aria-label={t("language")}
        value={locale}
        onChange={(event) => isLocale(event.target.value) && setLocale(event.target.value)}
        className="rounded-lg border border-zinc-300 bg-transparent px-2 py-2 dark:border-zinc-700"
      >
        {locales.map((l) => (
          <option key={l} value={l}>
            {localeLabels[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AppHeader() {
  const t = useTranslations("common");
  const token = useToken();
  const router = useRouter();
  const queryClient = useQueryClient();

  const logout = () => {
    clearToken();
    queryClient.clear();
    router.replace("/login");
  };

  return (
    <header className="flex items-center justify-between gap-4 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <Link href="/" className="text-lg font-semibold">
        {t("appName")}
      </Link>
      <div className="flex items-center gap-2">
        <LanguageSwitcher />
        {token ? (
          <Button variant="ghost" onClick={logout}>
            {t("logout")}
          </Button>
        ) : null}
      </div>
    </header>
  );
}
