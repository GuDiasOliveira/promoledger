/**
 * Access-token store. Kept in localStorage so the (future) offline sync queue can
 * authenticate after a reload. Subscribable for `useSyncExternalStore`.
 */

const STORAGE_KEY = "promoledger.token";
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

let current: string | null = typeof window === "undefined" ? null : read();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getToken(): string | null {
  return current;
}

export function setToken(token: string): void {
  current = token;
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage unavailable: the session lasts for this tab only.
  }
  emit();
}

export function clearToken(): void {
  current = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  emit();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Keep tabs in sync (login/logout in another tab).
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      current = event.newValue;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
