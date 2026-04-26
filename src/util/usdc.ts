/**
 * USDC math at 6 decimals.
 *
 * The SDK uses `bigint` everywhere for token amounts to avoid floating-point
 * truncation. These helpers are convenience converters between the user-facing
 * decimal-string form and the on-chain integer form.
 */

export const USDC_DECIMALS = 6;
const SCALE = 10n ** BigInt(USDC_DECIMALS);

/**
 * Parse a decimal USDC string into the on-chain integer.
 *
 * Examples: `"1"` -> `1_000_000n`, `"0.002"` -> `2_000n`, `"0.0001"` -> `100n`.
 * Rejects values with more than 6 fractional digits.
 */
export function parseUsdc(input: string | number): bigint {
  const s = typeof input === "number" ? String(input) : input;
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`invalid USDC amount: ${s}`);
  }
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const [whole, frac = ""] = body.split(".") as [string, string?];
  if (frac.length > USDC_DECIMALS) {
    throw new Error(`USDC supports up to ${USDC_DECIMALS} decimals, got ${frac.length}`);
  }
  const padded = (frac ?? "").padEnd(USDC_DECIMALS, "0");
  const value = BigInt(whole) * SCALE + BigInt(padded || "0");
  return negative ? -value : value;
}

/**
 * Format an on-chain integer USDC amount as a decimal string with up to
 * 6 fractional digits, trailing zeroes trimmed (but never trimming the
 * leading "0." for sub-unit values).
 */
export function formatUsdc(amount: bigint): string {
  const negative = amount < 0n;
  const v = negative ? -amount : amount;
  const whole = v / SCALE;
  const frac = v % SCALE;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  const body = fracStr.length === 0 ? `${whole}` : `${whole}.${fracStr}`;
  return negative ? `-${body}` : body;
}
