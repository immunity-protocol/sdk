// Pure USDC sizing math for the seed run.
//
// A publisher pays the registration bond from its wallet (pulled by the
// registrar) and funds an internal deposited balance that the registry debits
// per publish. Sizing is kept pure so it is unit-testable without a chain.

/** Sum of per-target publish bonds. */
export function sumBonds(bonds: bigint[]): bigint {
  return bonds.reduce((acc, b) => acc + b, 0n);
}

/** Add a percentage buffer to an amount (integer math, floor). */
export function withBuffer(amount: bigint, bufferPct: bigint): bigint {
  return amount + (amount * bufferPct) / 100n;
}

/** Deposit needed to cover all publish bonds, plus a buffer (default 50%). */
export function depositTarget(bonds: bigint[], bufferPct = 50n): bigint {
  return withBuffer(sumBonds(bonds), bufferPct);
}

/** USDC to mint into the wallet: registration bond + deposit, plus a buffer (default 20%). */
export function mintTarget(registrationBond: bigint, deposit: bigint, bufferPct = 20n): bigint {
  return withBuffer(registrationBond + deposit, bufferPct);
}
