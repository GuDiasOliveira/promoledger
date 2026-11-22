"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";

import { useToken } from "@/lib/hooks";

/** Renders children only with a session; otherwise redirects to /login. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const token = useToken();
  const router = useRouter();

  useEffect(() => {
    if (!token) router.replace("/login");
  }, [token, router]);

  return token ? <>{children}</> : null;
}
