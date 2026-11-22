"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useToken } from "@/lib/hooks";

export default function Home() {
  const token = useToken();
  const router = useRouter();

  useEffect(() => {
    router.replace(token ? "/promotions" : "/login");
  }, [token, router]);

  return null;
}
