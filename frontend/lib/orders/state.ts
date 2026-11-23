/**
 * Order lifecycle rules on the client — a mirror of the backend rules (docs/erm.md §2.8,
 * docs/api.md §8) used to enable buttons, derive optimistic state and plan conflict
 * resolution. The server remains the authority; these only avoid pointless requests.
 */
import type { CachedOrder, OutboxItem, TransitionKind } from "@/lib/db";

export interface OrderState {
  version: number;
  paidAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
}

export type Classification =
  | "UNPAID_PENDING"
  | "PAID_PENDING"
  | "DIVERGENCE"
  | "SETTLED"
  | "CANCELLED";

export const TRANSITIONS: TransitionKind[] = [
  "MARK_PAID",
  "MARK_DELIVERED",
  "REVOKE_PAYMENT",
  "REVOKE_DELIVERY",
  "CANCEL",
];

export const REASON_REQUIRED: ReadonlySet<TransitionKind> = new Set([
  "REVOKE_PAYMENT",
  "REVOKE_DELIVERY",
  "CANCEL",
]);

/** Endpoint + action of each kind (docs/api.md §8.1–8.3). */
export const ENDPOINT: Record<
  TransitionKind,
  { path: "payment" | "delivery" | "cancel"; action?: string }
> = {
  MARK_PAID: { path: "payment", action: "MARK_PAID" },
  REVOKE_PAYMENT: { path: "payment", action: "REVOKE_PAYMENT" },
  MARK_DELIVERED: { path: "delivery", action: "MARK_DELIVERED" },
  REVOKE_DELIVERY: { path: "delivery", action: "REVOKE_DELIVERY" },
  CANCEL: { path: "cancel" },
};

export function classify(state: OrderState): Classification {
  if (state.cancelledAt) return "CANCELLED";
  if (state.paidAt && state.deliveredAt) return "SETTLED";
  if (state.paidAt) return "PAID_PENDING";
  if (state.deliveredAt) return "DIVERGENCE";
  return "UNPAID_PENDING";
}

/** Same rules as the server's transition check (minus permissions). */
export function canApply(state: OrderState, kind: TransitionKind): boolean {
  if (state.cancelledAt) return false;
  switch (kind) {
    case "MARK_PAID":
      return !state.paidAt;
    case "REVOKE_PAYMENT":
      return Boolean(state.paidAt);
    case "MARK_DELIVERED":
      return !state.deliveredAt;
    case "REVOKE_DELIVERY":
      return Boolean(state.deliveredAt);
    case "CANCEL":
      return !state.deliveredAt && !state.paidAt;
  }
}

/** The order already is in the state this action aims for (e.g. someone else did it). */
export function isSatisfied(state: OrderState, kind: TransitionKind): boolean {
  switch (kind) {
    case "MARK_PAID":
      return Boolean(state.paidAt);
    case "REVOKE_PAYMENT":
      return !state.paidAt;
    case "MARK_DELIVERED":
      return Boolean(state.deliveredAt);
    case "REVOKE_DELIVERY":
      return !state.deliveredAt;
    case "CANCEL":
      return Boolean(state.cancelledAt);
  }
}

export function applyAction(state: OrderState, kind: TransitionKind, at: string): OrderState {
  const next = { ...state, version: state.version + 1 };
  switch (kind) {
    case "MARK_PAID":
      return { ...next, paidAt: at };
    case "REVOKE_PAYMENT":
      return { ...next, paidAt: null };
    case "MARK_DELIVERED":
      return { ...next, deliveredAt: at };
    case "REVOKE_DELIVERY":
      return { ...next, deliveredAt: null };
    case "CANCEL":
      return { ...next, cancelledAt: at };
  }
}

export const stateOf = (order: Pick<CachedOrder, keyof OrderState>): OrderState => ({
  version: order.version,
  paidAt: order.paidAt,
  deliveredAt: order.deliveredAt,
  cancelledAt: order.cancelledAt,
});

export const transitionKind = (item: OutboxItem) => item.payload.kind as TransitionKind;

export interface DerivedOrder {
  order: CachedOrder;
  state: OrderState; // snapshot + queued actions
  pending: TransitionKind[]; // queued, not yet confirmed by the server
  needsResolution: boolean; // an action was rejected (conflict/failed): user must decide
}

/**
 * Displayed state = last server snapshot + this order's PENDING actions, in queue order.
 * Rejected (conflict/failed) actions are NOT applied: they were refused by the server and
 * are shown only in the resolution UI — otherwise the badge would claim a state that the
 * same screen says was not reached.
 */
export function deriveOrder(order: CachedOrder, queue: OutboxItem[]): DerivedOrder {
  const mine = queue
    .filter((i) => i.kind === "transition" && i.localRef === order.key)
    .sort((a, b) => a.seq! - b.seq!);
  let state = stateOf(order);
  const pending: TransitionKind[] = [];
  for (const item of mine) {
    if (item.status !== "pending") continue;
    const kind = transitionKind(item);
    pending.push(kind);
    if (canApply(state, kind)) state = applyAction(state, kind, item.createdAt);
  }
  return {
    order,
    state,
    pending,
    needsResolution: mine.some((i) => i.status !== "pending"),
  };
}

export interface ReapplyPlan {
  apply: { kind: TransitionKind; expectedVersion: number; reason: string | null }[];
  alreadyDone: TransitionKind[]; // satisfied by someone else's change
  notApplicable: TransitionKind[]; // no longer allowed on the current server state
}

/**
 * Conflict resolution ("Reapply my actions"): replay the device's actions on top of the
 * CURRENT server state — skipping those already satisfied, dropping those no longer
 * allowed, and chaining fresh expected versions.
 */
export function planReapply(
  server: OrderState,
  actions: { kind: TransitionKind; reason: string | null }[],
  now: string,
): ReapplyPlan {
  const plan: ReapplyPlan = { apply: [], alreadyDone: [], notApplicable: [] };
  let state = server;
  for (const { kind, reason } of actions) {
    if (isSatisfied(state, kind)) plan.alreadyDone.push(kind);
    else if (!canApply(state, kind)) plan.notApplicable.push(kind);
    else {
      plan.apply.push({ kind, expectedVersion: state.version, reason });
      state = applyAction(state, kind, now);
    }
  }
  return plan;
}
