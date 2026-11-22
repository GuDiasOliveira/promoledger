import createClient, { type Middleware } from "openapi-fetch";

import { getToken } from "@/lib/auth/session";

import { NetworkError, toApiError } from "./errors";
import type { components, paths } from "./schema";

export type Schemas = components["schemas"];

const authMiddleware: Middleware = {
  onRequest({ request }) {
    const token = getToken();
    if (token) request.headers.set("Authorization", `Bearer ${token}`);
    return request;
  },
};

/** Same-origin client: `/api/v1/*` is proxied to FastAPI by next.config.ts rewrites. */
export const api = createClient<paths>({ baseUrl: "" });
api.use(authMiddleware);

type FetchResult<T> = { data?: T; error?: unknown; response: Response };

/**
 * Turn an openapi-fetch result into data or a typed error:
 * - no HTTP response at all  -> NetworkError (retryable when offline)
 * - HTTP error status        -> ApiError carrying the RFC 7807 problem
 */
export async function unwrap<T>(request: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>;
  try {
    result = await request;
  } catch (cause) {
    throw new NetworkError(cause);
  }
  if (!result.response.ok) {
    throw toApiError(result.response.status, result.error, new URL(result.response.url, "http://x").pathname);
  }
  return result.data as T;
}
