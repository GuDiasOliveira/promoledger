"use client";

import { useState } from "react";

/**
 * One error slot for a screen with several mutations: shows the MOST RECENT failure.
 * (`a.error ?? b.error` would keep showing an old error and hide the newer one.)
 */
export function useLastError() {
  const [error, setError] = useState<unknown>(null);
  return {
    error,
    handlers: {
      onMutate: () => setError(null),
      onError: (e: unknown) => setError(e),
    },
  };
}
