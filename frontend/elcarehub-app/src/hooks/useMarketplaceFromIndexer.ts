// ─────────────────────────────────────────────────────────────
// hooks/useMarketplaceFromIndexer.ts — Optimized marketplace hook
// with live SSE updates (ISSUE-061)
// ─────────────────────────────────────────────────────────────

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getAllListings, Listing } from "@/lib/contract";
import { fetchListings, subscribeToMarketplaceEvents, SSESubscription } from "@/lib/indexer";
import { config } from "@/lib/config";
import { getReadableErrorMessage } from "@/lib/errors";
import { useTransientErrorToast } from "./useTransientErrorToast";

/**
 * Fetches listings with indexer optimisation and keeps them live via SSE.
 *
 * - Makes 1 API call instead of N contract calls.
 * - Falls back to on-chain scan if the indexer is unreachable.
 * - Subscribes to the indexer SSE stream and merges incoming events
 *   (`LISTING_CREATED`, `LISTING_CANCELLED`, `ARTWORK_SOLD`) into state
 *   without requiring a manual page refresh.
 * - Debounces rapid bursts of SSE events before triggering a re-fetch.
 * - Cleans up the subscription on unmount.
 */
export function useMarketplaceFromIndexer(opts?: {
  status?: string;
  limit?: number;
  offset?: number;
}) {
  const [listings, setListings] = useState<Listing[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [isLive, setIsLive] = useState(false);

  useTransientErrorToast(error);

  // Keep a stable ref to the SSE subscription so cleanup works correctly
  // across re-renders without recreating the subscription on every render.
  const subscriptionRef = useRef<SSESubscription | null>(null);

  // ── Data fetching ────────────────────────────────────────

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      try {
        // Step 1: Try the indexer API (1 HTTP call for all results)
        const res = await fetchListings({
          status: opts?.status || "Active",
          limit: opts?.limit || 100,
          offset: opts?.offset || 0,
        });

        if (res.listings && res.listings.length >= 0) {
          setListings(res.listings as Listing[]);
          setTotal(res.total ?? res.listings.length);
          return;
        }
      } catch (e) {
        console.warn("[indexer] useMarketplaceFromIndexer fallback to on-chain:", e);
      }

      // Step 2: Fallback to on-chain scan (N CONTRACT CALLS — backup only)
      const all = await getAllListings();
      let filtered = all;
      if (opts?.status) {
        filtered = all.filter((l) => l.status === opts.status);
      }
      setListings(filtered);
      setTotal(filtered.length);
    } catch (err: unknown) {
      setError(getReadableErrorMessage(err, "Failed to load marketplace listings"));
    } finally {
      setIsLoading(false);
    }
  }, [opts?.status, opts?.limit, opts?.offset]);

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // ── SSE subscription ─────────────────────────────────────

  useEffect(() => {
    // Only subscribe in a browser environment with a configured indexer URL.
    if (typeof window === "undefined" || !config.indexerUrl) return;

    // Tear down any previous subscription before creating a new one.
    subscriptionRef.current?.close();
    subscriptionRef.current = null;

    const subscription = subscribeToMarketplaceEvents(config.indexerUrl, {
      onEvent: (_ev) => {
        // Any relevant event (LISTING_CREATED, ARTWORK_SOLD, LISTING_CANCELLED)
        // triggers a targeted refresh so the list stays up-to-date without
        // requiring the user to reload the page.
        refresh();
      },
      onOpen: () => setIsLive(true),
      onClose: () => setIsLive(false),
      debounceMs: 300,
      maxRetries: 10,
      baseRetryDelayMs: 1_000,
    });

    subscriptionRef.current = subscription;

    return () => {
      subscription.close();
      subscriptionRef.current = null;
      setIsLive(false);
    };
  }, [refresh, config.indexerUrl]);

  return { listings, total, isLoading, error, refresh, isLive };
}
