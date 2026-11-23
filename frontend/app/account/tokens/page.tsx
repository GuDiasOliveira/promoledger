"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useLayoutEffect, useState } from "react";

import { RequireAuth } from "@/components/require-auth";
import { Badge, Button, Card, ErrorBanner, Field } from "@/components/ui";
import { useLastError } from "@/lib/admin/last-error";
import { api, type Schemas, unwrap } from "@/lib/api/client";
import { formatDateTime } from "@/lib/format";
import { useErrorMessage } from "@/lib/hooks";
import { useOnline } from "@/lib/offline/hooks";

type Token = Schemas["ApiTokenResponse"];
const EXPIRY_OPTIONS = [30, 90, 180, 365] as const;

function status(token: Token): "active" | "revoked" | "expired" {
  if (token.revoked_at) return "revoked";
  return new Date(token.expires_at) <= new Date() ? "expired" : "active";
}

function NewTokenSecret({ token }: { token: string }) {
  const t = useTranslations("tokens");
  const [copied, setCopied] = useState(false);
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950"
    >
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{t("copyNow")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code
          className="break-all rounded bg-white px-2 py-1 text-sm dark:bg-zinc-900"
          data-testid="new-token"
        >
          {token}
        </code>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void navigator.clipboard?.writeText(token).then(() => setCopied(true))}
        >
          {copied ? t("copied") : t("copy")}
        </Button>
      </div>
    </div>
  );
}

function Tokens() {
  const t = useTranslations();
  const locale = useLocale();
  const online = useOnline();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const last = useLastError();
  const [name, setName] = useState("");
  const [days, setDays] = useState<number>(90);
  const [secret, setSecret] = useState<string | null>(null);

  // Never leave a plain token in a hidden (<Activity>-preserved) route: wipe it when hidden.
  useLayoutEffect(() => () => setSecret(null), []);

  const tokens = useQuery({
    queryKey: ["api-tokens"],
    queryFn: () => unwrap(api.GET("/api/v1/auth/tokens")),
    enabled: online,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["api-tokens"] });

  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/auth/tokens", { body: { name: name.trim(), expires_in_days: days } }),
      ),
    ...last.handlers,
    onSuccess: (created) => {
      setSecret(created.token);
      setName("");
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE("/api/v1/auth/tokens/{token_id}", { params: { path: { token_id: id } } })),
    ...last.handlers,
    onSuccess: refresh,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) create.mutate();
  };

  if (!online) {
    return (
      <Card>
        <p role="alert">{t("admin.onlineOnly")}</p>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <Link href="/promotions" className="text-sm text-indigo-600">
        ← {t("promotions.title")}
      </Link>
      <Card>
        <h1 className="text-xl font-semibold">{t("tokens.title")}</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{t("tokens.intro")}</p>
        <form
          onSubmit={submit}
          className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3"
          aria-label={t("tokens.create")}
        >
          <Field
            label={t("tokens.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
          />
          <label className="block space-y-1">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {t("tokens.expires")}
            </span>
            <select
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-3 dark:border-zinc-700 dark:bg-zinc-950"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {EXPIRY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {t("tokens.days", { count: d })}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <Button type="submit" className="w-full" disabled={!name.trim() || create.isPending}>
              {t("tokens.create")}
            </Button>
          </div>
        </form>
        {secret ? (
          <div className="mt-4">
            <NewTokenSecret token={secret} />
          </div>
        ) : null}
      </Card>
      <ErrorBanner
        message={
          last.error ? errorMessage(last.error) : tokens.error ? errorMessage(tokens.error) : null
        }
      />
      <Card>
        {!tokens.data ? (
          <p>{t("common.loading")}</p>
        ) : tokens.data.length === 0 ? (
          <p className="text-zinc-500">{t("tokens.empty")}</p>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {tokens.data.map((token) => {
              const state = status(token);
              return (
                <li
                  key={token.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-3"
                  data-testid="token-row"
                >
                  <div>
                    <span className="font-medium">{token.name}</span>{" "}
                    <code className="text-sm text-zinc-500">{token.prefix}…</code>{" "}
                    <Badge tone={state === "active" ? "green" : "amber"}>
                      {t(`tokens.status.${state}`)}
                    </Badge>
                    <p className="text-xs text-zinc-500">
                      {t("tokens.created", { date: formatDateTime(token.created_at, locale) })} ·{" "}
                      {t("tokens.expiresAt", { date: formatDateTime(token.expires_at, locale) })} ·{" "}
                      {token.last_used_at
                        ? t("tokens.lastUsed", { date: formatDateTime(token.last_used_at, locale) })
                        : t("tokens.neverUsed")}
                    </p>
                  </div>
                  {state === "active" ? (
                    <Button
                      variant="ghost"
                      disabled={revoke.isPending}
                      onClick={() =>
                        window.confirm(t("tokens.confirmRevoke")) && revoke.mutate(token.id)
                      }
                    >
                      {t("tokens.revoke")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function TokensPage() {
  return (
    <RequireAuth>
      <Tokens />
    </RequireAuth>
  );
}
