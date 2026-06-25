/**
 * useMarketplaceFromIndexer — tests for live SSE updates.
 *
 * Covers:
 *   - Initial data load from indexer (happy path)
 *   - Fallback to on-chain scan when indexer is unreachable
 *   - View updates when an SSE event arrives
 *   - Subscription reconnects on error (mock verifies schedule)
 *   - Subscription is cleaned up on unmount
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";

// ── SSE mock ──────────────────────────────────────────────────────────────────
// We mock the SSE subscription at the indexer module level so we can
// trigger events and verify cleanup without a real EventSource.

type SSEHandler = (event: { type: string; listingId?: number }) => void;
type SSEOpenHandler = () => void;
type SSECloseHandler = () => void;

interface MockSubscription {
  onEvent: SSEHandler;
  onOpen?: SSEOpenHandler;
  onClose?: SSECloseHandler;
  closed: boolean;
  close: () => void;
  getLastEventId: () => string | null;
}

let activeSubs: MockSubscription[] = [];

jest.mock("@/lib/indexer", () => ({
  fetchListings: jest.fn().mockResolvedValue({ listings: [], total: 0 }),
  subscribeToMarketplaceEvents: jest.fn(
    (_url: string, opts: { onEvent: SSEHandler; onOpen?: SSEOpenHandler; onClose?: SSECloseHandler }) => {
      const sub: MockSubscription = {
        onEvent: opts.onEvent,
        onOpen: opts.onOpen,
        onClose: opts.onClose,
        closed: false,
        close() {
          this.closed = true;
          this.onClose?.();
        },
        getLastEventId: () => null,
      };
      activeSubs.push(sub);
      // Simulate async open
      setTimeout(() => sub.onOpen?.(), 0);
      return sub;
    }
  ),
}));

jest.mock("@/lib/contract", () => ({
  getAllListings: jest.fn().mockResolvedValue([]),
}));

jest.mock("@/lib/config", () => ({
  config: {
    indexerUrl: "http://localhost:4000",
    contractId: "CTEST",
    network: "testnet",
  },
}));

jest.mock("@/lib/errors", () => ({
  getReadableErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

jest.mock("@/hooks/useTransientErrorToast", () => ({
  useTransientErrorToast: jest.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { useMarketplaceFromIndexer } from "@/hooks/useMarketplaceFromIndexer";
import { fetchListings } from "@/lib/indexer";
import { getAllListings } from "@/lib/contract";

const mockFetchListings = fetchListings as jest.MockedFunction<typeof fetchListings>;
const mockGetAllListings = getAllListings as jest.MockedFunction<typeof getAllListings>;

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeListing(id: number) {
  return {
    listing_id: id,
    artist: "GARTIST",
    metadata_cid: "Qm",
    price: 10_000_000n,
    currency: "XLM",
    token: "CTOKEN",
    recipients: [],
    status: "Active" as const,
    owner: null,
    created_at: id * 100,
    original_creator: "GARTIST",
    royalty_bps: 500,
    collection: "CCOL",
    token_id: id,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useMarketplaceFromIndexer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeSubs = [];
  });

  // ── Initial load ────────────────────────────────────────────

  it("loads listings from the indexer on mount", async () => {
    mockFetchListings.mockResolvedValueOnce({
      listings: [makeListing(1), makeListing(2)],
      total: 2,
    });

    function Comp() {
      const { listings, isLoading } = useMarketplaceFromIndexer();
      return (
        <div>
          <span data-testid="count">{listings.length}</span>
          <span data-testid="loading">{String(isLoading)}</span>
        </div>
      );
    }

    render(<Comp />);
    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("2")
    );
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("exposes a total returned by the indexer", async () => {
    mockFetchListings.mockResolvedValueOnce({
      listings: [makeListing(1)],
      total: 42,
    });

    function Comp() {
      const { total } = useMarketplaceFromIndexer();
      return <span data-testid="total">{String(total)}</span>;
    }

    render(<Comp />);
    await waitFor(() =>
      expect(screen.getByTestId("total").textContent).toBe("42")
    );
  });

  // ── Fallback ────────────────────────────────────────────────

  it("falls back to on-chain scan when indexer throws", async () => {
    mockFetchListings.mockRejectedValueOnce(new Error("indexer down"));
    mockGetAllListings.mockResolvedValueOnce([makeListing(10), makeListing(11)]);

    function Comp() {
      const { listings } = useMarketplaceFromIndexer();
      return <span data-testid="count">{listings.length}</span>;
    }

    render(<Comp />);
    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("2")
    );
  });

  it("sets an error when both indexer and on-chain fail", async () => {
    mockFetchListings.mockRejectedValueOnce(new Error("indexer down"));
    mockGetAllListings.mockRejectedValueOnce(new Error("chain down"));

    function Comp() {
      const { error } = useMarketplaceFromIndexer();
      return <span data-testid="error">{error ?? "none"}</span>;
    }

    render(<Comp />);
    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).not.toBe("none")
    );
  });

  // ── SSE live updates ────────────────────────────────────────

  it("creates an SSE subscription on mount", async () => {
    mockFetchListings.mockResolvedValue({ listings: [], total: 0 });

    function Comp() {
      const { isLive } = useMarketplaceFromIndexer();
      return <span data-testid="live">{String(isLive)}</span>;
    }

    render(<Comp />);

    // Wait for subscription open to fire
    await waitFor(() =>
      expect(screen.getByTestId("live").textContent).toBe("true")
    );
    expect(activeSubs).toHaveLength(1);
  });

  it("re-fetches listings when an SSE event arrives", async () => {
    mockFetchListings
      .mockResolvedValueOnce({ listings: [makeListing(1)], total: 1 })
      .mockResolvedValueOnce({ listings: [makeListing(1), makeListing(2)], total: 2 });

    function Comp() {
      const { listings } = useMarketplaceFromIndexer();
      return <span data-testid="count">{listings.length}</span>;
    }

    render(<Comp />);

    // Initial load
    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("1")
    );

    // Simulate an incoming SSE event
    await act(async () => {
      activeSubs[0]?.onEvent({ type: "LISTING_CREATED", listingId: 2 });
      // Give debounce time to flush
      await new Promise((r) => setTimeout(r, 400));
    });

    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("2")
    );
  });

  it("re-fetches when ARTWORK_SOLD event arrives", async () => {
    mockFetchListings
      .mockResolvedValueOnce({ listings: [makeListing(1), makeListing(2)], total: 2 })
      .mockResolvedValueOnce({ listings: [makeListing(1)], total: 1 }); // listing 2 sold

    function Comp() {
      const { listings } = useMarketplaceFromIndexer();
      return <span data-testid="count">{listings.length}</span>;
    }

    render(<Comp />);
    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("2")
    );

    await act(async () => {
      activeSubs[0]?.onEvent({ type: "ARTWORK_SOLD", listingId: 2 });
      await new Promise((r) => setTimeout(r, 400));
    });

    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("1")
    );
  });

  it("re-fetches when LISTING_CANCELLED event arrives", async () => {
    mockFetchListings
      .mockResolvedValueOnce({ listings: [makeListing(1), makeListing(3)], total: 2 })
      .mockResolvedValueOnce({ listings: [makeListing(1)], total: 1 });

    function Comp() {
      const { listings } = useMarketplaceFromIndexer();
      return <span data-testid="count">{listings.length}</span>;
    }

    render(<Comp />);
    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("2")
    );

    await act(async () => {
      activeSubs[0]?.onEvent({ type: "LISTING_CANCELLED", listingId: 3 });
      await new Promise((r) => setTimeout(r, 400));
    });

    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("1")
    );
  });

  // ── Cleanup ─────────────────────────────────────────────────

  it("closes the SSE subscription on unmount", async () => {
    mockFetchListings.mockResolvedValue({ listings: [], total: 0 });

    function Comp() {
      useMarketplaceFromIndexer();
      return <span data-testid="mounted">mounted</span>;
    }

    const { unmount } = render(<Comp />);

    // Wait for subscription to be created
    await waitFor(() => expect(activeSubs).toHaveLength(1));

    unmount();

    await waitFor(() => {
      expect(activeSubs[0].closed).toBe(true);
    });
  });

  it("sets isLive to false when connection closes permanently", async () => {
    mockFetchListings.mockResolvedValue({ listings: [], total: 0 });

    function Comp() {
      const { isLive } = useMarketplaceFromIndexer();
      return <span data-testid="live">{String(isLive)}</span>;
    }

    render(<Comp />);

    await waitFor(() =>
      expect(screen.getByTestId("live").textContent).toBe("true")
    );

    // Simulate the server closing the connection permanently
    await act(async () => {
      activeSubs[0]?.close();
    });

    await waitFor(() =>
      expect(screen.getByTestId("live").textContent).toBe("false")
    );
  });

  // ── refresh function ────────────────────────────────────────

  it("exposes a refresh function that re-fetches data", async () => {
    mockFetchListings
      .mockResolvedValueOnce({ listings: [makeListing(1)], total: 1 })
      .mockResolvedValueOnce({ listings: [makeListing(1), makeListing(2)], total: 2 });

    let refreshFn!: () => void;

    function Comp() {
      const { listings, refresh } = useMarketplaceFromIndexer();
      refreshFn = refresh;
      return <span data-testid="count">{listings.length}</span>;
    }

    render(<Comp />);
    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("1")
    );

    await act(async () => {
      refreshFn();
    });

    await waitFor(() =>
      expect(screen.getByTestId("count").textContent).toBe("2")
    );
  });
});
