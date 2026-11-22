"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, useLayoutEffect, useState } from "react";

import { api, unwrap } from "@/lib/api/client";
import { setToken } from "@/lib/auth/session";
import { useErrorMessage } from "@/lib/hooks";

import { Button, Card, ErrorBanner, Field } from "./ui";

type Mode = "login" | "register";

async function authenticate(email: string, password: string): Promise<void> {
  const { access_token } = await unwrap(
    api.POST("/api/v1/auth/token", { body: { email, password } }),
  );
  setToken(access_token);
}

export function AuthForm({ mode }: { mode: Mode }) {
  const t = useTranslations("auth");
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      if (mode === "register") {
        await unwrap(api.POST("/api/v1/auth/register", { body: { name, email, password } }));
      }
      await authenticate(email, password);
    },
    onSuccess: () => router.replace("/promotions"),
  });
  const { reset: resetSubmit } = submit;

  // Cache Components keeps visited routes mounted but hidden (React <Activity>), preserving
  // their state. Wipe credentials when this form is hidden, so a shared device never shows
  // the previous user's email/password after logout.
  useLayoutEffect(
    () => () => {
      setName("");
      setEmail("");
      setPassword("");
      resetSubmit();
    },
    [resetSubmit],
  );

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit.mutate();
  };

  const isRegister = mode === "register";
  return (
    <div className="mx-auto max-w-sm">
      <Card>
        <form onSubmit={onSubmit} className="space-y-4">
          <h1 className="text-xl font-semibold">{isRegister ? t("registerTitle") : t("loginTitle")}</h1>
          {isRegister ? (
            <Field label={t("name")} value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
          ) : null}
          <Field
            label={t("email")}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <Field
            label={t("password")}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={isRegister ? 8 : 1}
            hint={isRegister ? t("passwordHint") : undefined}
            autoComplete={isRegister ? "new-password" : "current-password"}
          />
          <ErrorBanner message={submit.isError ? errorMessage(submit.error) : null} />
          <Button type="submit" disabled={submit.isPending} className="w-full">
            {isRegister ? t("submitRegister") : t("submitLogin")}
          </Button>
          <p className="text-center text-sm text-zinc-600 dark:text-zinc-400">
            {isRegister ? t("haveAccount") : t("noAccount")}{" "}
            <Link href={isRegister ? "/login" : "/register"} className="font-medium text-indigo-600">
              {isRegister ? t("goLogin") : t("goRegister")}
            </Link>
          </p>
        </form>
      </Card>
    </div>
  );
}
