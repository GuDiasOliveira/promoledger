import { describe, expect, it } from "vitest";

import type { TransitionKind } from "@/lib/db";

import {
  applyAction,
  canApply,
  classify,
  isSatisfied,
  type OrderState,
  planReapply,
} from "./state";

const T = "2026-03-30T12:00:00Z";
const base: OrderState = { version: 1, paidAt: null, deliveredAt: null, cancelledAt: null };
const paid: OrderState = { ...base, paidAt: T };
const delivered: OrderState = { ...base, deliveredAt: T };
const settled: OrderState = { ...base, paidAt: T, deliveredAt: T };
const cancelled: OrderState = { ...base, cancelledAt: T };

describe("canApply mirrors the server transition rules", () => {
  it.each<[string, OrderState, TransitionKind[]]>([
    ["new order", base, ["MARK_PAID", "MARK_DELIVERED", "CANCEL"]],
    ["paid", paid, ["REVOKE_PAYMENT", "MARK_DELIVERED"]],
    ["delivered unpaid", delivered, ["MARK_PAID", "REVOKE_DELIVERY"]],
    ["settled", settled, ["REVOKE_PAYMENT", "REVOKE_DELIVERY"]],
    ["cancelled", cancelled, []],
  ])("%s", (_, state, allowed) => {
    const all: TransitionKind[] = [
      "MARK_PAID",
      "REVOKE_PAYMENT",
      "MARK_DELIVERED",
      "REVOKE_DELIVERY",
      "CANCEL",
    ];
    expect(all.filter((k) => canApply(state, k))).toEqual(allowed);
  });
});

describe("applyAction / classify", () => {
  it("bumps the version and sets/clears timestamps", () => {
    const s1 = applyAction(base, "MARK_PAID", T);
    const s2 = applyAction(s1, "MARK_DELIVERED", T);
    expect([s1.version, s2.version]).toEqual([2, 3]);
    expect(classify(s2)).toBe("SETTLED");
    expect(classify(applyAction(s2, "REVOKE_PAYMENT", T))).toBe("DIVERGENCE");
  });

  it.each<[OrderState, string]>([
    [base, "UNPAID_PENDING"],
    [paid, "PAID_PENDING"],
    [delivered, "DIVERGENCE"],
    [settled, "SETTLED"],
    [cancelled, "CANCELLED"],
  ])("classifies like ERM §3", (state, expected) => {
    expect(classify(state)).toBe(expected);
  });

  it("isSatisfied detects work already done by someone else", () => {
    expect(isSatisfied(paid, "MARK_PAID")).toBe(true);
    expect(isSatisfied(base, "REVOKE_PAYMENT")).toBe(true);
    expect(isSatisfied(base, "MARK_DELIVERED")).toBe(false);
  });
});

describe("planReapply (conflict resolution)", () => {
  it("admin marked PAID meanwhile; my DELIVERED is rebased on the new version", () => {
    const server = { ...paid, version: 2 };
    const plan = planReapply(server, [{ kind: "MARK_DELIVERED", reason: null }], T);
    expect(plan.apply).toEqual([{ kind: "MARK_DELIVERED", expectedVersion: 2, reason: null }]);
    expect(plan.alreadyDone).toEqual([]);
  });

  it("someone already did exactly what I did: nothing to apply", () => {
    const server = { ...delivered, version: 2 };
    const plan = planReapply(server, [{ kind: "MARK_DELIVERED", reason: null }], T);
    expect(plan).toEqual({ apply: [], alreadyDone: ["MARK_DELIVERED"], notApplicable: [] });
  });

  it("chains expected versions and drops actions no longer allowed", () => {
    const server = { ...paid, version: 2 }; // paid on the server: cancel is no longer allowed
    const plan = planReapply(
      server,
      [
        { kind: "CANCEL", reason: "gave up" },
        { kind: "MARK_DELIVERED", reason: null },
        { kind: "REVOKE_DELIVERY", reason: "damaged" },
      ],
      T,
    );
    expect(plan.notApplicable).toEqual(["CANCEL"]);
    expect(plan.apply).toEqual([
      { kind: "MARK_DELIVERED", expectedVersion: 2, reason: null },
      { kind: "REVOKE_DELIVERY", expectedVersion: 3, reason: "damaged" },
    ]);
  });
});
