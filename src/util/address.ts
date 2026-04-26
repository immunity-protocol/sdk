import type { Address } from "../types/antibody.js";

const ADDRESS_RE = /^0[xX][0-9a-fA-F]{40}$/;

/**
 * Validate and lowercase-normalize an EVM address. Returns the canonical
 * form the SDK uses internally for map keys and comparisons.
 */
export function normalizeAddress(input: string): Address {
  if (typeof input !== "string" || !ADDRESS_RE.test(input)) {
    throw new Error(`invalid address: ${String(input)}`);
  }
  return input.toLowerCase() as Address;
}

export function isAddress(input: unknown): input is Address {
  return typeof input === "string" && ADDRESS_RE.test(input);
}

/**
 * Compose a chain-scoped key for the AddressMatcher, e.g. `1:0xabc…`.
 * Chain id is always written as a decimal integer.
 */
export function chainAddressKey(chainId: number, addr: string): string {
  return `${chainId}:${normalizeAddress(addr)}`;
}
