"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

import { api, unwrap } from "@/lib/api/client";
import { ApiError, NetworkError } from "@/lib/api/errors";
import { getToken, subscribe } from "@/lib/auth/session";

export function useToken(): string | null {
  return useSyncExternalStore(subscribe, getToken, () => null);
}

export function useMe() {
  const token = useToken();
  return useQuery({
    queryKey: ["me", token],
    queryFn: () => unwrap(api.GET("/api/v1/auth/me")),
    enabled: token !== null,
  });
}

/** Translate an error: known backend `code` -> localized text, else the server's detail. */
export function useErrorMessage(): (error: unknown) => string {
  const t = useTranslations("errors");
  return (error) => {
    if (error instanceof NetworkError) return t("network");
    if (error instanceof ApiError) {
      const key = `codes.${error.code}` as const;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic key lookup
      return t.has(key as any) ? t(key as any) : error.problem.detail;
    }
    return t("generic");
  };
}
