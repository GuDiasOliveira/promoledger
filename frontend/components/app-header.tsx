"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

import { clearToken } from "@/lib/auth/session";
import { isLocale, localeLabels, locales } from "@/lib/i18n/config";
import { setLocale } from "@/lib/i18n/store";
import { useToken } from "@/lib/hooks";

import { useOnline, useOutbox, useUserId } from "@/lib/offline/hooks";

import { Badge, Button } from "./ui";

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
        className="max-w-40 rounded-lg border border-zinc-300 bg-transparent px-2 py-2 text-sm dark:border-zinc-700"
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

function ConnectivityBadge({ pending }: { pending: number }) {
  const t = useTranslations("common");
  const online = useOnline();
  return (
    <span className="flex items-center gap-1" data-testid="connectivity">
      <Badge tone={online ? "green" : "amber"}>{online ? t("online") : t("offline")}</Badge>
      {pending > 0 ? <Badge tone="amber">{t("pending", { count: pending })}</Badge> : null}
    </span>
  );
}

export function AppHeader() {
  const t = useTranslations("common");
  const token = useToken();
  const router = useRouter();
  const queryClient = useQueryClient();

  const pending = useOutbox(useUserId())?.length ?? 0;

  const logout = () => {
    // Pending changes stay on the device, scoped to this user, and are sent at next login.
    if (pending > 0 && !window.confirm(t("logoutPending", { count: pending }))) return;
    clearToken();
    queryClient.clear();
    router.replace("/login");
  };

  return (
    // flex-wrap: on narrow phones the controls drop to a second line instead of overflowing,
    // which would widen the layout viewport and push fixed bottom bars off-screen.
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <Link href="/" className="text-lg font-semibold">
        {t("appName")}
      </Link>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        {token ? <ConnectivityBadge pending={pending} /> : null}
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
