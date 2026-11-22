import { describe, expect, it } from "vitest";

import { ApiError, isProblemDetails, toApiError } from "./errors";

const problem = {
  type: "https://api.promoledger.org/errors/concurrency-conflict",
  title: "Conflict",
  status: 409,
  code: "CONCURRENCY_CONFLICT",
  detail: "Order version mismatch (expected: 2, current: 3). Please refresh and retry.",
  instance: "/api/v1/promotions/p/orders/o/payment",
  errors: [],
};

describe("toApiError", () => {
  it("keeps an RFC 7807 body as-is", () => {
    const error = toApiError(409, problem);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("CONCURRENCY_CONFLICT");
    expect(error.problem.detail).toContain("expected: 2, current: 3");
  });

  it("wraps a non-RFC 7807 body (e.g. a proxy/gateway error)", () => {
    const error = toApiError(502, "Bad Gateway", "/api/v1/health");

    expect(error.code).toBe("HTTP_502");
    expect(error.problem.detail).toBe("Bad Gateway");
    expect(error.problem.instance).toBe("/api/v1/health");
  });

  it("handles an empty body", () => {
    expect(toApiError(500, undefined).problem.detail).toBe("Request failed with status 500");
  });
});

describe("isProblemDetails", () => {
  it.each([null, undefined, "x", {}, { status: 400 }, { status: "400", code: "X", detail: "" }])(
    "rejects %j",
    (value) => {
      expect(isProblemDetails(value)).toBe(false);
    },
  );
});
