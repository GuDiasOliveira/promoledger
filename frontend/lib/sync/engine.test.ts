import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError, toApiError } from "@/lib/api/errors";
import { type OutboxItem, PromoLedgerDB } from "@/lib/db";

import { backoffDelay, MAX_DELAY_MS, retryItem, runSync } from "./engine";
import { createCustomerOffline, createOrderOffline, discardOutboxItem } from "./outbox";

const USER_A = "user-a";
const USER_B = "user-b";
const PROMO = "promo-1";

let db: PromoLedgerDB;
let clock = 1_000_000;
const now = () => clock;
const random = () => 0.5; // no jitter

beforeEach(() => {
  db = new PromoLedgerDB(`test-${crypto.randomUUID()}`);
  clock = 1_000_000;
});
afterEach(async () => {
  await db.delete();
});

const problem = (status: number, code: string) => toApiError(status, { status, code, detail: code });

async function seedCustomerAndOrder(userId = USER_A) {
  const customer = await createCustomerOffline(db, {
    userId,
    promotionId: PROMO,
    name: "Ana",
    contact: null,
  });
  const order = await createOrderOffline(db, {
    userId,
    promotionId: PROMO,
    customerId: customer.id,
    customerName: customer.name,
    lines: [{ productId: "p1", name: "Egg", quantity: 2, unitPrice: "19.90" }],
    markPaidNow: false,
  });
  return { customer, order };
}

describe("backoffDelay", () => {
  it("doubles from 1s and caps at 60s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map((n) => backoffDelay(n, random))).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ]);
  });

  it("applies ±20% jitter", () => {
    expect(backoffDelay(3, () => 0)).toBe(3200);
    expect(backoffDelay(3, () => 0.999999)).toBe(4800);
    expect(backoffDelay(50, () => 0.999999)).toBeLessThanOrEqual(MAX_DELAY_MS * 1.2);
  });
});

describe("offline mutations", () => {
  it("write the local record and its outbox entry atomically", async () => {
    const { customer, order } = await seedCustomerAndOrder();

    expect(await db.customers.get(customer.key)).toMatchObject({ sync: "pending" });
    expect(await db.orders.get(order.key)).toMatchObject({ sync: "pending", serverId: null });
    const outbox = await db.outbox.orderBy("seq").toArray();
    expect(outbox.map((i) => i.kind)).toEqual(["createCustomer", "createOrder"]);
    // The order references the offline (client-generated) customer id.
    expect(outbox[1].payload).toMatchObject({ customer_id: customer.id });
    expect(outbox[1].idempotencyKey).toBe(order.idempotencyKey);
  });

  it("discard removes the queued item and its optimistic record", async () => {
    const { order } = await seedCustomerAndOrder();
    const orderItem = (await db.outbox.filter((i) => i.kind === "createOrder").first())!;

    await discardOutboxItem(db, orderItem);

    expect(await db.orders.get(order.key)).toBeUndefined();
    expect(await db.outbox.count()).toBe(1);
  });
});

describe("runSync", () => {
  it("sends FIFO (customer before order) and empties the queue", async () => {
    await seedCustomerAndOrder();
    const send = vi.fn(async (_item: OutboxItem) => {});

    const report = await runSync({ db, userId: USER_A, send, now, random });

    expect(report).toMatchObject({ outcome: "done", sent: 2, failed: 0 });
    expect(send.mock.calls.map(([item]) => item.kind)).toEqual(["createCustomer", "createOrder"]);
    expect(await db.outbox.count()).toBe(0);
  });

  it("reports idle when nothing is pending", async () => {
    expect(await runSync({ db, userId: USER_A, send: vi.fn(), now, random })).toMatchObject({
      outcome: "idle",
    });
  });

  it("on a network error: stops, keeps order, schedules backoff, reuses the same key", async () => {
    await seedCustomerAndOrder();
    const keys: string[] = [];
    const send = vi.fn(async (item: OutboxItem) => {
      keys.push(item.idempotencyKey);
      throw new NetworkError();
    });

    const first = await runSync({ db, userId: USER_A, send, now, random });
    expect(first).toMatchObject({ outcome: "retrying", sent: 0, nextRunAt: clock + 1000 });
    expect(send).toHaveBeenCalledTimes(1); // the order was NOT attempted before its customer

    // Before the retry time: nothing is sent.
    expect(await runSync({ db, userId: USER_A, send, now, random })).toMatchObject({
      outcome: "waiting",
    });
    expect(send).toHaveBeenCalledTimes(1);

    clock += 1000;
    const second = await runSync({ db, userId: USER_A, send, now, random });
    expect(second).toMatchObject({ outcome: "retrying", nextRunAt: clock + 2000 });
    expect(new Set(keys).size).toBe(1); // identical Idempotency-Key on every attempt
  });

  it.each([500, 502, 503, 429])("treats HTTP %i as transient", async (status) => {
    await seedCustomerAndOrder();
    const send = vi.fn(async () => {
      throw problem(status, "X");
    });

    const report = await runSync({ db, userId: USER_A, send, now, random });

    expect(report.outcome).toBe("retrying");
    expect((await db.outbox.orderBy("seq").first())?.status).toBe("pending");
  });

  it("on 401: pauses everything without consuming attempts", async () => {
    await seedCustomerAndOrder();
    const send = vi.fn(async () => {
      throw problem(401, "TOKEN_EXPIRED");
    });

    const report = await runSync({ db, userId: USER_A, send, now, random });

    expect(report.outcome).toBe("auth_required");
    const head = await db.outbox.orderBy("seq").first();
    expect(head).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: 0 });
  });

  it("on 4xx: marks failed/conflict, flags the record, and continues with the rest", async () => {
    await seedCustomerAndOrder();
    await seedCustomerAndOrder(); // a second, independent pair
    const rejected: string[] = [];
    let call = 0;
    const send = vi.fn(async () => {
      call += 1;
      if (call === 1) throw problem(409, "CUSTOMER_ID_CONFLICT");
      if (call === 2) throw problem(404, "CUSTOMER_NOT_FOUND"); // its dependent order
    });

    const report = await runSync({
      db,
      userId: USER_A,
      send,
      now,
      random,
      onRejected: async (item, status) => {
        rejected.push(`${item.kind}:${status}`);
      },
    });

    expect(report).toMatchObject({ outcome: "done", sent: 2, failed: 2 });
    expect(rejected).toEqual(["createCustomer:conflict", "createOrder:failed"]);
    const left = await db.outbox.orderBy("seq").toArray();
    expect(left.map((i) => [i.status, i.lastError?.code])).toEqual([
      ["conflict", "CUSTOMER_ID_CONFLICT"],
      ["failed", "CUSTOMER_NOT_FOUND"],
    ]);
  });

  it("retryItem puts a failed item back in the queue with the SAME key", async () => {
    await seedCustomerAndOrder();
    await runSync({
      db,
      userId: USER_A,
      send: async () => {
        throw problem(400, "PROMOTION_NOT_ACTIVE");
      },
      now,
      random,
    });
    const failed = await db.outbox.orderBy("seq").first();
    expect(failed?.status).toBe("failed");

    await retryItem(db, failed!.seq!);
    const sentKeys: string[] = [];
    await runSync({ db, userId: USER_A, send: async (i) => void sentKeys.push(i.idempotencyKey), now, random });

    expect(sentKeys).toEqual([failed!.idempotencyKey]); // only the retried item, same key
    // The order was rejected too and was not retried: it stays failed, untouched.
    const left = await db.outbox.toArray();
    expect(left.map((i) => [i.kind, i.status])).toEqual([["createOrder", "failed"]]);
  });

  it("never sends another user's queue (shared devices)", async () => {
    await seedCustomerAndOrder(USER_A);
    await seedCustomerAndOrder(USER_B);
    const send = vi.fn(async (_item: OutboxItem) => {});

    await runSync({ db, userId: USER_B, send, now, random });

    expect(send.mock.calls.every(([item]) => item.userId === USER_B)).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await db.outbox.where("userId").equals(USER_A).count()).toBe(2);
  });

  it("rethrows programming errors instead of swallowing them", async () => {
    await seedCustomerAndOrder();
    await expect(
      runSync({
        db,
        userId: USER_A,
        send: async () => {
          throw new TypeError("bug");
        },
        now,
        random,
      }),
    ).rejects.toThrow("bug");
  });

  it("ApiError is not confused with transient errors", () => {
    expect(problem(400, "X")).toBeInstanceOf(ApiError);
  });
});
