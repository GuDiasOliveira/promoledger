/** RFC 7807 Problem Details as returned by the backend (docs/api.md §1.5). */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance: string;
  errors: { loc: (string | number)[]; msg: string; type: string }[];
}

export function isProblemDetails(value: unknown): value is ProblemDetails {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.status === "number" && typeof v.code === "string" && typeof v.detail === "string";
}

/** The server answered with an error status. */
export class ApiError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(`${problem.status} ${problem.code}: ${problem.detail}`);
    this.name = "ApiError";
    this.problem = problem;
  }

  get status(): number {
    return this.problem.status;
  }

  get code(): string {
    return this.problem.code;
  }
}

/** The request never got an HTTP response (offline, DNS, connection reset...). */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super("Network request failed", { cause });
    this.name = "NetworkError";
  }
}

/** Build an ApiError even when a proxy/gateway returns a non-RFC 7807 body. */
export function toApiError(status: number, body: unknown, instance = ""): ApiError {
  if (isProblemDetails(body)) return new ApiError(body);
  return new ApiError({
    type: "about:blank",
    title: "HTTP error",
    status,
    code: `HTTP_${status}`,
    detail: typeof body === "string" && body ? body : `Request failed with status ${status}`,
    instance,
    errors: [],
  });
}
