"use client";

import { useEffect } from "react";

import { useUserId } from "@/lib/offline/hooks";
import { startSyncRunner } from "@/lib/sync/runner";

/** Runs the outbox sync for the logged-in user (restarts when the user changes). */
export function SyncRunner() {
  const userId = useUserId();
  useEffect(() => (userId ? startSyncRunner() : undefined), [userId]);
  return null;
}
