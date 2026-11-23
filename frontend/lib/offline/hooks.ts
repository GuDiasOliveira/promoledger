"use client";

import { useQuery } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { useSyncExternalStore } from "react";

import { getUserId } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { useToken } from "@/lib/hooks";
import { getLastOutcome, subscribeOutcome } from "@/lib/sync/runner";

import { deriveOrder } from "@/lib/orders/state";
import { blockedItems } from "@/lib/sync/engine";

import { refreshCatalog, refreshCustomers, refreshOrders, refreshPromotions } from "./refresh";

export function useUserId(): string | null {
  return getUserId(useToken());
}

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

export function useSyncOutcome() {
  return useSyncExternalStore(subscribeOutcome, getLastOutcome, () => null);
}

/** Pull fresh server data into IndexedDB when possible; never blocks the (cached) UI. */
function useRefresh(key: unknown[], enabled: boolean, refresh: () => Promise<void>) {
  return useQuery({
    queryKey: ["refresh", ...key],
    queryFn: async () => {
      await refresh();
      return Date.now();
    },
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function usePromotions(userId: string | null) {
  useRefresh(["promotions", userId], userId !== null, () => refreshPromotions(db, userId!));
  return useLiveQuery(
    () => (userId ? db.promotions.where("userId").equals(userId).sortBy("name") : []),
    [userId],
  );
}

export function usePromotion(userId: string | null, promotionId: string | null) {
  const promotions = usePromotions(userId);
  return promotions?.find((p) => p.id === promotionId) ?? (promotions ? null : undefined);
}

/** Warm the offline catalog + customers for a promotion (call while online). */
export function usePromotionData(userId: string | null, promotionId: string | null) {
  const enabled = userId !== null && promotionId !== null;
  useRefresh(["catalog", userId, promotionId], enabled, () =>
    refreshCatalog(db, userId!, promotionId!),
  );
  useRefresh(["customers", userId, promotionId], enabled, () =>
    refreshCustomers(db, userId!, promotionId!),
  );
  const products = useLiveQuery(
    () =>
      enabled
        ? db.products.where("[userId+promotionId]").equals([userId, promotionId]).sortBy("name")
        : [],
    [userId, promotionId],
  );
  const customers = useLiveQuery(
    () =>
      enabled
        ? db.customers.where("[userId+promotionId]").equals([userId, promotionId]).sortBy("name")
        : [],
    [userId, promotionId],
  );
  return { products, customers };
}

/** Outbox rows of the current user (optionally one promotion), FIFO order. */
export function useOutbox(userId: string | null, promotionId?: string | null) {
  return useLiveQuery(async () => {
    if (!userId) return [];
    const rows = await db.outbox.where("userId").equals(userId).sortBy("seq");
    return promotionId ? rows.filter((r) => r.promotionId === promotionId) : rows;
  }, [userId, promotionId]);
}

/** The seller's orders for a promotion, each derived as server snapshot + queued actions. */
export function useOrders(userId: string | null, promotionId: string | null) {
  const enabled = userId !== null && promotionId !== null;
  useRefresh(["orders", userId, promotionId], enabled, () =>
    refreshOrders(db, userId!, promotionId!),
  );
  return useLiveQuery(async () => {
    if (!enabled) return [];
    const [orders, queue] = await Promise.all([
      db.orders.where("[userId+promotionId]").equals([userId, promotionId]).toArray(),
      db.outbox.where("userId").equals(userId).sortBy("seq"),
    ]);
    return orders
      .map((order) => deriveOrder(order, queue))
      .sort((a, b) => b.order.createdAt.localeCompare(a.order.createdAt));
  }, [userId, promotionId]);
}

/** One order (by local key), derived, plus whether its creation is still queued. */
export function useOrder(orderKey: string | null) {
  return useLiveQuery(async () => {
    if (!orderKey) return null;
    const order = await db.orders.get(orderKey);
    if (!order) return null;
    const queue = await db.outbox.where("userId").equals(order.userId).sortBy("seq");
    const held = blockedItems(queue);
    return {
      ...deriveOrder(order, queue),
      actions: queue.filter((i) => i.kind === "transition" && i.localRef === orderKey),
      held,
    };
  }, [orderKey]);
}
