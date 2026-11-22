"use client";

/**
 * Admin/viewer data: ONLINE ONLY (decision 1, Slice 4.4). Straight from the API through
 * React Query — no IndexedDB, no outbox — so it is always current and the whole
 * promotion's data is never persisted on a (possibly shared) desktop.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api, type Schemas, unwrap } from "@/lib/api/client";
import type { TransitionKind } from "@/lib/db";
import { ENDPOINT } from "@/lib/orders/state";

import { type OrderFilters, orderFiltersToApi } from "./filters";

export const PAGE_SIZE = 20;
const path = (promotionId: string) => ({ promotion_id: promotionId });

export function useSummary(promotionId: string) {
  return useQuery({
    queryKey: ["admin", promotionId, "summary"],
    queryFn: () =>
      unwrap(api.GET("/api/v1/promotions/{promotion_id}/reconciliation/summary", { params: { path: path(promotionId) } })),
  });
}

export function useLeaderboard(promotionId: string) {
  return useQuery({
    queryKey: ["admin", promotionId, "leaderboard"],
    queryFn: () =>
      unwrap(api.GET("/api/v1/promotions/{promotion_id}/reconciliation/leaderboard", { params: { path: path(promotionId) } })),
  });
}

export function useDivergences(promotionId: string) {
  return useQuery({
    queryKey: ["admin", promotionId, "divergences"],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/promotions/{promotion_id}/reconciliation/divergences", {
          params: { path: path(promotionId), query: { page: 1, size: 100 } },
        }),
      ),
  });
}

export function useAdminOrders(promotionId: string, filters: OrderFilters) {
  return useQuery({
    queryKey: ["admin", promotionId, "orders", filters],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/promotions/{promotion_id}/orders", {
          params: { path: path(promotionId), query: orderFiltersToApi(filters, PAGE_SIZE) },
        }),
      ),
    placeholderData: keepPreviousData,
  });
}

export function useAdminOrder(promotionId: string, orderId: string | null) {
  return useQuery({
    queryKey: ["admin", promotionId, "order", orderId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/promotions/{promotion_id}/orders/{order_id}", {
          params: { path: { ...path(promotionId), order_id: orderId! } },
        }),
      ),
    enabled: orderId !== null,
  });
}

export function useAuditEvents(promotionId: string, page: number, eventType: string | null) {
  return useQuery({
    queryKey: ["admin", promotionId, "audit", page, eventType],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/promotions/{promotion_id}/reconciliation/audit-events", {
          params: {
            path: path(promotionId),
            query: {
              page,
              size: PAGE_SIZE,
              ...(eventType ? { event_type: eventType as Schemas["AuditEventType"] } : {}),
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  });
}

/** member_id -> display name, INCLUDING revoked members (history must keep its authors). */
export function useMemberNames(promotionId: string) {
  return useQuery({
    queryKey: ["admin", promotionId, "member-names"],
    queryFn: async () => {
      const names = new Map<string, string>();
      for (let page = 1; page <= 10; page += 1) {
        const result = await unwrap(
          api.GET("/api/v1/promotions/{promotion_id}/members", {
            params: { path: path(promotionId), query: { include_revoked: true, page, size: 100 } },
          }),
        );
        for (const member of result.items) names.set(member.id, member.user.name);
        if (page * 100 >= result.total) break;
      }
      return names;
    },
    staleTime: 5 * 60_000,
  });
}

export function useCustomerSearch(promotionId: string, q: string) {
  return useQuery({
    queryKey: ["admin", promotionId, "customers", q],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/promotions/{promotion_id}/customers", {
          params: { path: path(promotionId), query: { q, page: 1, size: 8 } },
        }),
      ),
    enabled: q.trim().length >= 2,
  });
}

/**
 * One admin action, sent immediately. A fresh Idempotency-Key per click: a retry of the
 * SAME click (network error) is handled by React Query's mutation not being re-fired;
 * a deliberate second click after a conflict is a new decision with the new version.
 */
export async function runAdminTransition(
  promotionId: string,
  orderId: string,
  kind: TransitionKind,
  expectedVersion: number,
  reason: string | null,
) {
  const params = {
    path: { ...path(promotionId), order_id: orderId },
    header: { "Idempotency-Key": crypto.randomUUID() },
  };
  const body = {
    ...(ENDPOINT[kind].action ? { action: ENDPOINT[kind].action } : {}),
    expected_version: expectedVersion,
    ...(reason ? { reason } : {}),
  } as never;
  const endpoint = ENDPOINT[kind].path;
  return unwrap(
    endpoint === "payment"
      ? api.POST("/api/v1/promotions/{promotion_id}/orders/{order_id}/payment", { params, body })
      : endpoint === "delivery"
        ? api.POST("/api/v1/promotions/{promotion_id}/orders/{order_id}/delivery", { params, body })
        : api.POST("/api/v1/promotions/{promotion_id}/orders/{order_id}/cancel", { params, body }),
  );
}
