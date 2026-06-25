// ─────────────────────────────────────────────────────────────
// lib/validation.ts — Shared validation utilities
// ─────────────────────────────────────────────────────────────

/**
 * Returns true if the given string looks like a valid Stellar public key (G...)
 * or a valid Stellar contract address (C...).
 *
 * Stellar addresses are 56-character base-32 strings:
 *   - Public keys start with G
 *   - Contract addresses start with C
 */
export function isValidStellarAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  // Must be 56 characters, start with G (public key) or C (contract/muxed)
  if (trimmed.length !== 56) return false;
  if (!/^[GCM]/.test(trimmed)) return false;
  // Must consist only of base-32 characters (uppercase alphanumeric excluding 0, O, I, L)
  return /^[A-Z2-7]{56}$/.test(trimmed);
}

/**
 * Returns true if the given string looks like a valid Stellar public key (G...).
 */
export function isValidStellarPublicKey(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  return trimmed.length === 56 && /^G[A-Z2-7]{55}$/.test(trimmed);
}
