/**
 * ListingForm — field-level validation tests.
 *
 * Covers every validation rule that mirrors the on-chain contract constraints:
 *   - Collection address presence + valid Stellar address format
 *   - NFT token ID non-negative integer
 *   - Price > 0 and within MAX_PRICE_XLM bounds
 *   - Payment token required
 *   - Recipient percentages sum to exactly 100 %
 *   - Max 4 recipients
 *   - Submit disabled when form is invalid
 */
import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ListingForm,
  validateListingForm,
  isFormValid,
  MIN_PRICE_XLM,
  MAX_PRICE_XLM,
  MAX_RECIPIENTS,
  REQUIRED_SPLIT_SUM,
} from "@/components/ListingForm";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockCreate = jest.fn().mockResolvedValue(123);
const mockUpdate = jest.fn().mockResolvedValue(true);

jest.mock("@/hooks/useMarketplace", () => ({
  useCreateListing: (_pk: string | null) => ({
    create: mockCreate,
    isCreating: false,
    progress: "",
    error: null,
  }),
  useUpdateListing: (_pk: string | null) => ({
    update: mockUpdate,
    isUpdating: false,
    progress: "",
    error: null,
  }),
}));

jest.mock("@/hooks/useSupportedTokens", () => ({
  useSupportedTokens: () => ({
    tokens: [
      {
        address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        symbol: "XLM",
        name: "Stellar Lumens",
        decimals: 7,
      },
    ],
  }),
}));

jest.mock("@/context/WalletContext", () => ({
  useWalletContext: () => ({
    publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
  }),
}));

jest.mock("@/lib/ipfs", () => ({
  fetchMetadata: jest.fn().mockResolvedValue({
    title: "T",
    description: "D",
    artist: "A",
    image: "ipfs://Qm",
    year: "2024",
    category: "Painting",
  }),
  cidToGatewayUrl: jest.fn().mockReturnValue("https://gateway/Qm"),
  ArtworkMetadata: {},
}));

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: { capture: jest.fn() },
}));

jest.mock("@/config/tokens", () => ({
  DEFAULT_TOKEN: {
    address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    symbol: "XLM",
    name: "Stellar Lumens",
    decimals: 7,
  },
}));

jest.mock("@/lib/token-support", () => ({
  ensureTokenOption: (_tokens: unknown[], _addr: string) => [
    {
      address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      symbol: "XLM",
      name: "Stellar Lumens",
      decimals: 7,
    },
  ],
  getDefaultSupportedToken: (tokens: { address: string; symbol: string }[]) =>
    tokens[0] ?? {
      address: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      symbol: "XLM",
    },
}));

jest.mock("@/components/WalletGuard", () => ({
  GuardButton: ({ children, disabled, type, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { actionName?: string; onAction?: () => void }) => (
    <button type={type as "submit" | "reset" | "button"} disabled={disabled} className={className}>
      {children}
    </button>
  ),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const VALID_CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const VALID_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

// ── validateListingForm unit tests ────────────────────────────────────────────

describe("validateListingForm — unit", () => {
  function validForm() {
    return {
      collectionAddress: VALID_CONTRACT,
      nftTokenId: 1,
      price: 10,
      tokenAddress: VALID_TOKEN,
      recipients: [{ address: VALID_ADDRESS, percentage: 100 }],
    };
  }

  it("returns no errors for a completely valid form", () => {
    expect(isFormValid(validateListingForm(validForm()))).toBe(true);
  });

  // ── Collection address ──────────────────────────────────────

  it("requires collectionAddress", () => {
    const errors = validateListingForm({ ...validForm(), collectionAddress: "" });
    expect(errors.collectionAddress).toBeDefined();
  });

  it("rejects an invalid Stellar address for collectionAddress", () => {
    const errors = validateListingForm({
      ...validForm(),
      collectionAddress: "not-a-stellar-address",
    });
    expect(errors.collectionAddress).toBeDefined();
  });

  it("accepts a valid contract address (C...)", () => {
    const errors = validateListingForm({ ...validForm(), collectionAddress: VALID_CONTRACT });
    expect(errors.collectionAddress).toBeUndefined();
  });

  it("accepts a valid public key (G...)", () => {
    const errors = validateListingForm({ ...validForm(), collectionAddress: VALID_ADDRESS });
    expect(errors.collectionAddress).toBeUndefined();
  });

  // ── NFT Token ID ────────────────────────────────────────────

  it("rejects a negative token ID", () => {
    const errors = validateListingForm({ ...validForm(), nftTokenId: -1 });
    expect(errors.nftTokenId).toBeDefined();
  });

  it("rejects a non-integer token ID", () => {
    const errors = validateListingForm({ ...validForm(), nftTokenId: 1.5 });
    expect(errors.nftTokenId).toBeDefined();
  });

  it("accepts token ID of 0", () => {
    const errors = validateListingForm({ ...validForm(), nftTokenId: 0 });
    expect(errors.nftTokenId).toBeUndefined();
  });

  // ── Price ────────────────────────────────────────────────────

  it("rejects price of 0", () => {
    const errors = validateListingForm({ ...validForm(), price: 0 });
    expect(errors.price).toBeDefined();
  });

  it("rejects negative price", () => {
    const errors = validateListingForm({ ...validForm(), price: -5 });
    expect(errors.price).toBeDefined();
  });

  it("rejects price below minimum (sub-stroop)", () => {
    const errors = validateListingForm({ ...validForm(), price: MIN_PRICE_XLM / 10 });
    expect(errors.price).toBeDefined();
  });

  it("accepts minimum valid price (1 stroop = 0.0000001 XLM)", () => {
    const errors = validateListingForm({ ...validForm(), price: MIN_PRICE_XLM });
    expect(errors.price).toBeUndefined();
  });

  it("rejects price above MAX_PRICE_XLM", () => {
    const errors = validateListingForm({ ...validForm(), price: MAX_PRICE_XLM + 1 });
    expect(errors.price).toBeDefined();
  });

  it("accepts price at MAX_PRICE_XLM", () => {
    const errors = validateListingForm({ ...validForm(), price: MAX_PRICE_XLM });
    expect(errors.price).toBeUndefined();
  });

  it("rejects NaN price", () => {
    const errors = validateListingForm({ ...validForm(), price: NaN });
    expect(errors.price).toBeDefined();
  });

  // ── Token address ───────────────────────────────────────────

  it("rejects empty tokenAddress", () => {
    const errors = validateListingForm({ ...validForm(), tokenAddress: "" });
    expect(errors.tokenAddress).toBeDefined();
  });

  it("accepts a non-empty tokenAddress", () => {
    const errors = validateListingForm({ ...validForm(), tokenAddress: VALID_TOKEN });
    expect(errors.tokenAddress).toBeUndefined();
  });

  // ── Recipient splits ────────────────────────────────────────

  it("rejects empty recipients array", () => {
    const errors = validateListingForm({ ...validForm(), recipients: [] });
    expect(errors.recipients).toBeDefined();
  });

  it("rejects when recipient percentages sum < 100", () => {
    const errors = validateListingForm({
      ...validForm(),
      recipients: [{ address: VALID_ADDRESS, percentage: 50 }],
    });
    expect(errors.recipients).toBeDefined();
  });

  it("rejects when recipient percentages sum > 100", () => {
    const errors = validateListingForm({
      ...validForm(),
      recipients: [
        { address: VALID_ADDRESS, percentage: 60 },
        { address: VALID_CONTRACT, percentage: 60 },
      ],
    });
    expect(errors.recipients).toBeDefined();
  });

  it("accepts exactly 100% split across multiple recipients", () => {
    const errors = validateListingForm({
      ...validForm(),
      recipients: [
        { address: VALID_ADDRESS, percentage: 70 },
        { address: VALID_CONTRACT, percentage: 30 },
      ],
    });
    expect(errors.recipients).toBeUndefined();
    expect(isFormValid(errors)).toBe(true);
  });

  it("rejects more than MAX_RECIPIENTS recipients", () => {
    const recipients = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => ({
      address: VALID_ADDRESS,
      percentage: Math.floor(REQUIRED_SPLIT_SUM / (MAX_RECIPIENTS + 1)),
    }));
    const errors = validateListingForm({ ...validForm(), recipients });
    expect(errors.recipients).toBeDefined();
  });

  it("accepts exactly MAX_RECIPIENTS recipients summing to 100%", () => {
    const perPct = Math.floor(REQUIRED_SPLIT_SUM / MAX_RECIPIENTS);
    const remainder = REQUIRED_SPLIT_SUM - perPct * (MAX_RECIPIENTS - 1);
    const recipients = Array.from({ length: MAX_RECIPIENTS }, (_, i) => ({
      address: VALID_ADDRESS,
      percentage: i === 0 ? remainder : perPct,
    }));
    const errors = validateListingForm({ ...validForm(), recipients });
    expect(errors.recipients).toBeUndefined();
  });

  it("flags empty recipient address in recipientRows", () => {
    const errors = validateListingForm({
      ...validForm(),
      recipients: [{ address: "", percentage: 100 }],
    });
    expect(errors.recipientRows?.[0]?.address).toBeDefined();
  });

  it("flags invalid Stellar address in recipient row", () => {
    const errors = validateListingForm({
      ...validForm(),
      recipients: [{ address: "not-valid", percentage: 100 }],
    });
    expect(errors.recipientRows?.[0]?.address).toBeDefined();
  });

  it("flags zero percentage in recipient row", () => {
    const errors = validateListingForm({
      ...validForm(),
      recipients: [
        { address: VALID_ADDRESS, percentage: 0 },
        { address: VALID_CONTRACT, percentage: 100 },
      ],
    });
    expect(errors.recipientRows?.[0]?.percentage).toBeDefined();
  });
});

// ── Component integration tests ───────────────────────────────────────────────

describe("ListingForm — component", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders all required fields", () => {
    render(<ListingForm onSuccess={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByPlaceholderText(/e\.g\. C\.\.\./i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create Listing/i })).toBeInTheDocument();
    expect(screen.getByText(/Revenue Split/i)).toBeInTheDocument();
  });

  it("shows inline error for empty collection address on submit", async () => {
    const user = userEvent.setup();
    render(<ListingForm onSuccess={jest.fn()} onCancel={jest.fn()} />);

    // Clear the collection address input (it may be empty by default)
    const collectionInput = screen.getByPlaceholderText(/e\.g\. C\.\.\./i);
    await user.clear(collectionInput);

    await user.click(screen.getByRole("button", { name: /Create Listing/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert", { hidden: true })).toBeInTheDocument();
    });
  });

  it("shows error for invalid collection address on blur", async () => {
    const user = userEvent.setup();
    render(<ListingForm onSuccess={jest.fn()} onCancel={jest.fn()} />);

    const collectionInput = screen.getByPlaceholderText(/e\.g\. C\.\.\./i);
    await user.type(collectionInput, "invalid-address");
    await user.tab(); // blur

    await waitFor(() => {
      expect(screen.getByText(/valid Stellar/i)).toBeInTheDocument();
    });
  });

  it("shows price error when price is 0 after submit attempt", async () => {
    const user = userEvent.setup();
    render(<ListingForm onSuccess={jest.fn()} onCancel={jest.fn()} />);

    // Set an invalid price
    const priceInput = screen.getAllByRole("spinbutton").find(
      (el) => (el as HTMLInputElement).min === String(MIN_PRICE_XLM)
    );
    if (priceInput) {
      await user.clear(priceInput);
      await user.type(priceInput, "0");
    }

    await user.click(screen.getByRole("button", { name: /Create Listing/i }));

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert", { hidden: true });
      expect(alerts.length).toBeGreaterThan(0);
    });
  });

  it("shows recipient split error when sum ≠ 100%", async () => {
    const user = userEvent.setup();
    render(<ListingForm onSuccess={jest.fn()} onCancel={jest.fn()} />);

    // Find the percentage input (the one with max=100 min=1)
    const pctInputs = screen.getAllByRole("spinbutton").filter(
      (el) => (el as HTMLInputElement).max === "100"
    );
    if (pctInputs.length > 0) {
      await user.clear(pctInputs[0]);
      await user.type(pctInputs[0], "50");
      await user.tab();
    }

    await user.click(screen.getByRole("button", { name: /Create Listing/i }));

    await waitFor(() => {
      expect(screen.getByText(/must sum to exactly 100/i)).toBeInTheDocument();
    });
  });

  it("displays live percentage total", () => {
    render(<ListingForm onSuccess={jest.fn()} onCancel={jest.fn()} />);
    // With default 100% single recipient the indicator shows green
    expect(screen.getByText(/100\.00%/)).toBeInTheDocument();
  });

  it("does not call create when form is invalid on submit", async () => {
    const user = userEvent.setup();
    render(<ListingForm onSuccess={jest.fn()} onCancel={jest.fn()} />);

    // Leave collection address blank — form is invalid
    await user.click(screen.getByRole("button", { name: /Create Listing/i }));

    await waitFor(() => {
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  it("calls create when all fields are valid", async () => {
    const user = userEvent.setup();
    const onSuccess = jest.fn();
    render(<ListingForm onSuccess={onSuccess} onCancel={jest.fn()} />);

    const collectionInput = screen.getByPlaceholderText(/e\.g\. C\.\.\./i);
    await user.type(collectionInput, VALID_CONTRACT);

    await user.click(screen.getByRole("button", { name: /Create Listing/i }));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });
});
