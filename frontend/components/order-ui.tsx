"use client";

import { useTranslations } from "next-intl";

import type { Classification } from "@/lib/orders/state";

import { Badge } from "./ui";

const TONE: Record<Classification, "neutral" | "green" | "amber"> = {
  UNPAID_PENDING: "neutral",
  PAID_PENDING: "amber",
  DIVERGENCE: "amber",
  SETTLED: "green",
  CANCELLED: "neutral",
};

export function ClassificationBadge({ value }: { value: Classification }) {
  const t = useTranslations("orders.classification");
  return <Badge tone={TONE[value]}>{t(value)}</Badge>;
}
