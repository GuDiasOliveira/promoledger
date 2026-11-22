import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toApiError } from "@/lib/api/errors";
import { type CachedOrder, type OutboxItem, PromoLedgerDB } from "@/lib/db";
import { deriveOrder } from "@/lib/orders/state";

import { blockedItems, runSync } from "./engine";
import {
  createCustomerOffline,
  createOrderOffline,
  discardOrderActions,
  discardOutboxItem,
  enqueueTransition,
  reapplyOrderActions,
  TransitionNotAllowed,
} from "./outbox";

const USER = "user-a";
const PROMO = "promo-1";
let db: PromoLedgerDB;

beforeEach(() => {
  db = new PromoLedgerDB(`test-${crypto.randomUUID()}`);
});
afterEach(async () => {
  await db.delete();
});

async function offlineOrder(markPaidNow = false): Promise<CachedOrder> {
  const customer = await createCustomerOffline(db, { userId: USER, promotionId: PROMO, name: "Ana", contact: null });
  return createOrderOffline(db, {
    userId: USER,
    promotionId: PROMO,
    customerId: customer.id,
    customerName: "Ana",
    lines: [{ productId: "p1", name: "Egg", quantity: 1, unitPrice: "19.90" }],
    markPaidNow,
  });
}

const queue = () => db.outbox.orderBy("seq").toArray();
const transitions = async () => (await queue()).filter((i) => i.kind === "transition");
const bodyOf = (i: OutboxItem) => i.payload.body as { action?: string; expected_version: number; reason?: string };

describe("enqueueTransition", () => {
  it("chains expected versions on an order that was never sent", async () => {
    const order = await offlineOrder();

    await enqueueTransition(db, order.key, "MARK_PAID");
    await enqueueTransition(db, order.key, "MARK_DELIVERED");

    const [pay, deliver] = await transitions();
    expect(bodyOf(pay)).toEqual({ action: "MARK_PAID", expected_version: 1 });
    expect(bodyOf(deliver)).toEqual({ action: "MARK_DELIVERED", expected_version: 2 });
    expect(pay.deps).toEqual([order.key]);
    expect(pay.idempotencyKey).not.toBe(deliver.idempotencyKey);

    const derived = deriveOrder((await db.orders.get(order.key))!, await queue());
    expect(derived.state).toMatchObject({ version: 3 });
    expect(derived.pending).toEqual(["MARK_PAID", "MARK_DELIVERED"]);
  });

  it("knows 'paid now' at creation: payment cannot be marked twice", async () => {
    const order = await offlineOrder(true);
    await expect(enqueueTransition(db, order.key, "MARK_PAID")).rejects.toBeInstanceOf(TransitionNotAllowed);
    await enqueueTransition(db, order.key, "MARK_DELIVERED");
    expect(bodyOf((await transitions())[0]).expected_version).toBe(1);
  });

  it("requires a non-blank reason for revocations and cancellation", async () => {
    const order = await offlineOrder();
    await expect(enqueueTransition(db, order.key, "CANCEL", "  ")).rejects.toThrow("requires a reason");
    await enqueueTransition(db, order.key, "CANCEL", "  Customer gave up ");
    expect(bodyOf((await transitions())[0])).toEqual({ expected_version: 1, reason: "Customer gave up" });
  });

  it("refuses new actions while the order has an unresolved conflict", async () => {
    const order = await offlineOrder();
    await enqueueTransition(db, order.key, "MARK_DELIVERED");
    const [action] = await transitions();
    await db.outbox.update(action.seq!, { status: "conflict" });

    await expect(enqueueTransition(db, order.key, "MARK_PAID")).rejects.toThrow("Resolve the conflict first");
  });
});

describe("dependency holds for order actions", () => {
  it("a conflicted action holds the later actions of the same order, not other orders", async () => {
    const a = await offlineOrder();
    const b = await offlineOrder();
    await enqueueTransition(db, a.key, "MARK_PAID");
    await enqueueTransition(db, a.key, "MARK_DELIVERED");
    await enqueueTransition(db, b.key, "MARK_PAID");
    const sent: string[] = [];

    await runSync({
      db,
      userId: USER,
      now: () => 0,
      random: () => 0.5,
      send: async (item) => {
        if (item.kind === "transition" && item.localRef === a.key && bodyOf(item).action === "MARK_PAID") {
          throw toApiError(409, { status: 409, code: "CONCURRENCY_CONFLICT", detail: "x" });
        }
        sent.push(item.kind === "transition" ? `${item.localRef === a.key ? "A" : "B"}:${bodyOf(item).action}` : item.kind);
      },
    });

    expect(sent).toContain("B:MARK_PAID");
    expect(sent).not.toContain("A:MARK_DELIVERED"); // held behind A's conflict
    const left = await queue();
    expect(left.map((i) => [bodyOf(i).action, i.status])).toEqual([
      ["MARK_PAID", "conflict"],
      ["MARK_DELIVERED", "pending"],
    ]);
    expect(blockedItems(left).size).toBe(1);
  });
});

describe("displayed state", () => {
  it("never applies a rejected action (the badge must not claim an unreached state)", async () => {
    const order = await offlineOrder();
    await db.orders.update(order.key, { serverId: "srv-1", sync: "synced", version: 2, paidAt: "2026-03-30T10:00:00Z" });
    await enqueueTransition(db, order.key, "MARK_DELIVERED");
    const [action] = await transitions();
    await db.outbox.update(action.seq!, { status: "conflict" });

    const derived = deriveOrder((await db.orders.get(order.key))!, await queue());

    expect(derived.needsResolution).toBe(true);
    expect(derived.state.deliveredAt).toBeNull(); // server truth: paid, NOT delivered
    expect(derived.pending).toEqual([]);
  });
});

describe("conflict resolution", () => {
  async function conflictedDelivery() {
    const order = await offlineOrder();
    await db.orders.update(order.key, { serverId: "srv-1", sync: "synced" });
    await enqueueTransition(db, order.key, "MARK_DELIVERED");
    const [action] = await transitions();
    await db.outbox.update(action.seq!, { status: "conflict" });
    return { order, action };
  }

  it("reapply: rebases on the server state with a NEW key and fresh version", async () => {
    const { order, action } = await conflictedDelivery();
    const server = { version: 2, paidAt: "2026-03-30T10:00:00Z", deliveredAt: null, cancelledAt: null };

    const plan = await reapplyOrderActions(db, order.key, server);

    expect(plan.apply).toHaveLength(1);
    const [rebased] = await transitions();
    expect(rebased.status).toBe("pending");
    expect(bodyOf(rebased)).toEqual({ action: "MARK_DELIVERED", expected_version: 2 });
    expect(rebased.idempotencyKey).not.toBe(action.idempotencyKey);
    expect(await db.orders.get(order.key)).toMatchObject({ version: 2, paidAt: server.paidAt });
  });

  it("reapply with everything already done leaves nothing queued", async () => {
    const { order } = await conflictedDelivery();
    const server = { version: 2, paidAt: null, deliveredAt: "2026-03-30T10:00:00Z", cancelledAt: null };

    const plan = await reapplyOrderActions(db, order.key, server);

    expect(plan.alreadyDone).toEqual(["MARK_DELIVERED"]);
    expect(await transitions()).toHaveLength(0);
  });

  it("discard drops the order's actions and keeps the server state", async () => {
    const { order } = await conflictedDelivery();
    const server = { version: 2, paidAt: "2026-03-30T10:00:00Z", deliveredAt: null, cancelledAt: null };

    await discardOrderActions(db, order.key, server);

    expect(await transitions()).toHaveLength(0);
    expect(await db.orders.get(order.key)).toMatchObject({ version: 2 });
  });
});

describe("discardOutboxItem cascades", () => {
  it("discarding an action also drops the later actions chained on the same order", async () => {
    const order = await offlineOrder();
    await enqueueTransition(db, order.key, "MARK_PAID");
    await enqueueTransition(db, order.key, "MARK_DELIVERED");
    const [pay] = await transitions();

    await discardOutboxItem(db, pay);

    expect(await transitions()).toHaveLength(0);
    expect(await db.orders.get(order.key)).toBeDefined(); // the order itself stays
  });

  it("discarding a customer also drops its order and that order's actions", async () => {
    const order = await offlineOrder();
    await enqueueTransition(db, order.key, "MARK_PAID");
    const [customerItem] = await queue();

    await discardOutboxItem(db, customerItem);

    expect(await queue()).toHaveLength(0);
    expect(await db.orders.get(order.key)).toBeUndefined();
  });
});
