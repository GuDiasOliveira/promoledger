"use client";

import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

import { ApiError } from "@/lib/api/errors";
import { clearToken } from "@/lib/auth/session";
import { messages } from "@/lib/i18n/config";
import { getLocale, subscribeLocale } from "@/lib/i18n/store";

import { SyncRunner } from "./sync-runner";

/** Any 401 means the token is unusable: drop it so the guard sends the user to login. */
function onAuthError(error: unknown): void {
  if (error instanceof ApiError && error.status === 401) clearToken();
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: onAuthError }),
    mutationCache: new MutationCache({ onError: onAuthError }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Retry transient/network failures only; an HTTP error answer won't change on retry.
        retry: (failureCount, error) => !(error instanceof ApiError) && failureCount < 2,
      },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  // Locale is resolved in the browser (stored choice, else navigator.languages), so pages
  // stay static and cacheable for the offline PWA. Server snapshot is null: nothing that
  // depends on locale or session renders until the client snapshot is available.
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => null);

  useEffect(() => {
    if (locale) document.documentElement.lang = locale;
  }, [locale]);

  if (!locale) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale={locale}
        messages={messages[locale]}
        timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      >
        <SyncRunner />
        {children}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}
