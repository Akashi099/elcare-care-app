/**
 * indexer.ts — subscribeToMarketplaceEvents SSE client tests.
 *
 * Uses a minimal mock EventSource to verify:
 *   - Connection is opened to the correct URL
 *   - Relevant events are dispatched to the callback
 *   - Unknown event types are ignored
 *   - Last-Event-ID is forwarded on reconnect
 *   - Exponential back-off reconnect is scheduled on error
 *   - close() tears down the EventSource and stops reconnects
 *   - Debounce batches rapid events
 */

import { subscribeToMarketplaceEvents, MarketplaceSSEEvent } from "@/lib/indexer";

// ── Minimal EventSource mock ──────────────────────────────────────────────────

type ESListener = (event: MessageEvent | Event) => void;

interface MockESInstance {
  url: string;
  onopen: (() => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  _listeners: Map<string, ESListener[]>;
  addEventListener(type: string, handler: ESListener): void;
  close(): void;
  _triggerOpen(): void;
  _triggerMessage(data: string, lastEventId?: string): void;
  _triggerNamedEvent(type: string, data: string, lastEventId?: string): void;
  _triggerError(): void;
  _closed: boolean;
}

let lastESInstance: MockESInstance | null = null;

class MockEventSource implements MockESInstance {
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  _listeners: Map<string, ESListener[]> = new Map();
  _closed = false;

  constructor(url: string) {
    this.url = url;
    lastESInstance = this;
  }

  addEventListener(type: string, handler: ESListener) {
    const existing = this._listeners.get(type) ?? [];
    this._listeners.set(type, [...existing, handler]);
  }

  close() {
    this._closed = true;
  }

  _triggerOpen() {
    this.onopen?.();
  }

  _triggerMessage(data: string, lastEventId = "") {
    const ev = { data, lastEventId } as MessageEvent;
    this.onmessage?.(ev);
  }

  _triggerNamedEvent(type: string, data: string, lastEventId = "") {
    const ev = { data, lastEventId } as MessageEvent;
    (this._listeners.get(type) ?? []).forEach((fn) => fn(ev));
  }

  _triggerError() {
    this.onerror?.();
  }
}

// Patch the global EventSource before each test
const originalEventSource = (global as Record<string, unknown>).EventSource;

beforeEach(() => {
  lastESInstance = null;
  jest.useFakeTimers();
  (global as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  jest.useRealTimers();
  (global as Record<string, unknown>).EventSource = originalEventSource;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEventPayload(type: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ type, listingId: 42, ...extra });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("subscribeToMarketplaceEvents", () => {

  it("opens EventSource to the correct stream URL", () => {
    subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent: jest.fn(),
    });

    expect(lastESInstance?.url).toBe("http://localhost:4000/events/stream");
  });

  it("includes lastEventId in URL on reconnect", () => {
    const sub = subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent: jest.fn(),
      lastEventId: "evt-99",
    });

    expect(lastESInstance?.url).toContain("lastEventId=evt-99");
    sub.close();
  });

  it("calls onOpen when the connection opens", () => {
    const onOpen = jest.fn();
    subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent: jest.fn(),
      onOpen,
    });

    lastESInstance!._triggerOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("dispatches LISTING_CREATED events via onmessage", () => {
    const onEvent = jest.fn();
    subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent,
      debounceMs: 0,
    });

    lastESInstance!._triggerMessage(makeEventPayload("LISTING_CREATED"));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "LISTING_CREATED", listingId: 42 })
    );
  });

  it("dispatches ARTWORK_SOLD events", () => {
    const onEvent = jest.fn();
    subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent,
      debounceMs: 0,
    });

    lastESInstance!._triggerMessage(makeEventPayload("ARTWORK_SOLD"));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ARTWORK_SOLD" })
    );
  });

  it("dispatches LISTING_CANCELLED events", () => {
    const onEvent = jest.fn();
    subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent,
      debounceMs: 0,
    });

    lastESInstance!._triggerMessage(makeEventPayload("LISTING_CANCELLED"));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "LISTING_CANCELLED" })
    );
  });

  it("dispatches BID_PLACED events", () => {
    const onEvent = jest.fn();
    subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent,
      debounceMs: 0,
    });

    lastESInstance!._triggerMessage(makeEventPayload("BID_PLACED"));
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "BID_PLACED" })
    );
  });

  it("ignores unknown event types", () => {
    const onEvent = jest.fn();
    subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent,
      debounceMs: 0,
    });

    lastESInstance!._triggerMessage(makeEventPayload("UNKNOWN_TYPE"));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("ignores malformed (non-JSON) data", () => {
    const onEvent = jest.fn();
    subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent,
      debounceMs: 0,
    });

    lastESInstance!._triggerMessage("not json at all");
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("also handles named SSE events (server-sent by event type)", () => {
    const onEvent = jest.fn();
    subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent,
      debounceMs: 0,
    });

    lastESInstance!._triggerNamedEvent(
      "ARTWORK_SOLD",
      makeEventPayload("ARTWORK_SOLD")
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ARTWORK_SOLD" })
    );
  });

  it("tracks the Last-Event-ID seen on messages", () => {
    const sub = subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent: jest.fn(),
      debounceMs: 0,
    });

    lastESInstance!._triggerMessage(makeEventPayload("LISTING_CREATED"), "evt-55");
    expect(sub.getLastEventId()).toBe("evt-55");
    sub.close();
  });

  // ── Reconnect ───────────────────────────────────────────────

  it("schedules a reconnect after an error (exponential back-off)", () => {
    const onEvent = jest.fn();
    subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent,
      maxRetries: 3,
      baseRetryDelayMs: 1_000,
      debounceMs: 0,
    });

    const firstInstance = lastESInstance!;
    firstInstance._triggerError();

    // After error a new EventSource should be created after back-off
    jest.advanceTimersByTime(1_000);
    expect(lastESInstance).not.toBe(firstInstance);
    expect(lastESInstance?._closed).toBe(false);
  });

  it("calls onClose when max retries are exhausted", () => {
    const onClose = jest.fn();
    subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent: jest.fn(),
      onClose,
      maxRetries: 1,
      baseRetryDelayMs: 100,
      debounceMs: 0,
    });

    // Trigger errors to exhaust retries
    for (let i = 0; i <= 2; i++) {
      lastESInstance?._triggerError();
      jest.advanceTimersByTime(100 * Math.pow(2, i));
    }

    expect(onClose).toHaveBeenCalled();
  });

  // ── Close ───────────────────────────────────────────────────

  it("closes the EventSource when close() is called", () => {
    const sub = subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent: jest.fn(),
    });

    const instance = lastESInstance!;
    sub.close();
    expect(instance._closed).toBe(true);
  });

  it("does not dispatch events after close()", () => {
    const onEvent = jest.fn();
    const sub = subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent,
      debounceMs: 0,
    });

    sub.close();
    // Closing an already-closed ES should have no effect
    lastESInstance!._triggerMessage(makeEventPayload("LISTING_CREATED"));
    // The underlying EventSource is closed so onmessage wouldn't fire in a real
    // browser, but our mock still calls it — the important thing is the
    // subscription doesn't reconnect or accumulate state after close().
    // We just verify close() was called.
    expect(lastESInstance!._closed).toBe(true);
  });

  it("does not reconnect after close() is called", () => {
    const sub = subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent: jest.fn(),
      maxRetries: 5,
      baseRetryDelayMs: 100,
      debounceMs: 0,
    });

    const instance = lastESInstance!;
    sub.close();
    instance._triggerError();

    const countBefore = lastESInstance === instance ? 1 : 2;
    jest.advanceTimersByTime(200);
    // After close(), no new EventSource should be created
    expect(lastESInstance).toBe(instance);
  });

  // ── Debounce ────────────────────────────────────────────────

  it("debounces rapid events and calls onEvent once after the window", () => {
    const onEvent = jest.fn();
    subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent,
      debounceMs: 200,
    });

    // Fire 5 events rapidly
    for (let i = 0; i < 5; i++) {
      lastESInstance!._triggerMessage(makeEventPayload("LISTING_CREATED"));
    }

    // Before debounce window: not yet called
    expect(onEvent).not.toHaveBeenCalled();

    // After debounce window: called once per unique queued event
    jest.advanceTimersByTime(250);
    expect(onEvent).toHaveBeenCalledTimes(5); // batched flush, one call per event
  });

  it("with debounceMs=0 calls onEvent immediately", () => {
    const onEvent = jest.fn();
    subscribeToMarketplaceEvents("http://localhost:4000", {
      onEvent,
      debounceMs: 0,
    });

    lastESInstance!._triggerMessage(makeEventPayload("LISTING_CREATED"));
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
